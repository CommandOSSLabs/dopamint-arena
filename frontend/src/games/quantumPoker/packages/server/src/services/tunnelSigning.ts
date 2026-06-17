import {
  blake2b256,
  SignatureScheme,
  verify,
  type SignFn,
  type VerifyFn,
} from "sui-tunnel-ts/core/crypto";
import {
  serializeStateUpdate,
  type StateUpdate,
} from "sui-tunnel-ts/core/wire";
import type { Party, Protocol } from "sui-tunnel-ts/protocol/Protocol";
import type { CoSignedUpdate } from "./tunnelTypes";

export interface PrepareProtocolStepParams {
  tunnelId: string;
  currentNonce: bigint;
  timestamp?: bigint;
  total: bigint;
}

export interface PreparedProtocolStep<State> {
  nextState: State;
  update: StateUpdate;
  message: Uint8Array;
  messageBytes: number;
}

export interface StateUpdateVerifier {
  publicKey: Uint8Array;
  scheme: number;
  verify?: VerifyFn;
}

export function prepareProtocolStep<State, Move>(
  protocol: Protocol<State, Move>,
  state: State,
  move: Move,
  by: Party,
  p: PrepareProtocolStepParams,
): PreparedProtocolStep<State> {
  const nextState = protocol.applyMove(state, move, by);
  const { a, b } = protocol.balances(nextState);
  if (a + b !== p.total) {
    throw new Error(`balance sum ${a + b} != locked total ${p.total}`);
  }
  const update: StateUpdate = {
    tunnelId: p.tunnelId,
    stateHash: blake2b256(protocol.encodeState(nextState)),
    nonce: p.currentNonce + 1n,
    timestamp: p.timestamp ?? 0n,
    partyABalance: a,
    partyBBalance: b,
  };
  const message = serializeStateUpdate(update);
  return { nextState, update, message, messageBytes: message.length };
}

export function signPreparedStep(
  prepared: PreparedProtocolStep<unknown>,
  signer: SignFn,
): Uint8Array {
  return signer(prepared.message);
}

export function verifyPreparedStepSignature(
  prepared: PreparedProtocolStep<unknown>,
  signature: Uint8Array,
  party: StateUpdateVerifier,
): boolean {
  if (party.scheme !== SignatureScheme.ED25519) {
    throw new Error(
      "verifyPreparedStepSignature currently supports ed25519 only",
    );
  }
  return party.verify
    ? party.verify(prepared.message, signature)
    : verify(signature, prepared.message, party.publicKey);
}

export interface CompletedPreparedStep {
  signed: CoSignedUpdate;
  verified: boolean;
}

export function completePreparedStep(
  prepared: PreparedProtocolStep<unknown>,
  sigA: Uint8Array,
  sigB: Uint8Array,
  partyA: StateUpdateVerifier,
  partyB: StateUpdateVerifier,
): CompletedPreparedStep {
  const verified =
    verifyPreparedStepSignature(prepared, sigA, partyA) &&
    verifyPreparedStepSignature(prepared, sigB, partyB);
  if (!verified) {
    throw new Error("co-signed update failed verification");
  }
  return {
    signed: { update: prepared.update, sigA, sigB },
    verified,
  };
}
