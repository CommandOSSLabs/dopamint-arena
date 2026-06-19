import {
  blake2b256,
  ed25519Address,
  keyPairFromRng,
  nobleBackend,
  type KeyPair,
} from "sui-tunnel-ts/core/crypto";
import {
  DistributedTunnel,
  type Transport,
} from "sui-tunnel-ts/core/distributedTunnel";
import type { CoSignedUpdate, PartyEndpoint } from "sui-tunnel-ts/core/tunnel";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  type PokerMove,
  type PokerState,
  QuantumPokerProtocol,
} from "sui-tunnel-ts/protocol/quantumPoker";
import { pokerMoveCodec } from "sui-tunnel-ts/protocol/quantumPokerCodec";
import {
  JULES_PROFILE,
  NARI_PROFILE,
  QuantumPokerPersonaDriver,
  type QuantumPokerBotProfile,
} from "sui-tunnel-ts/protocol/quantumPokerPersona";

export interface QuantumPokerRuntimeStep {
  by: Party;
  move: PokerMove;
  nonce: bigint;
  latest: CoSignedUpdate;
}

export interface QuantumPokerRuntimeSnapshot {
  state: PokerState;
  nonce: bigint;
  latest: CoSignedUpdate | null;
  stateHash: Uint8Array;
  userHoles: number[] | null;
  botHoles: number[] | null;
  seatA: QuantumPokerBotProfile;
  seatB: QuantumPokerBotProfile;
}

function makeLoopbackTransport(): { a: Transport; b: Transport } {
  let aCb: ((frame: Uint8Array) => void) | null = null;
  let bCb: ((frame: Uint8Array) => void) | null = null;
  return {
    a: {
      send: (frame) => bCb?.(frame),
      onFrame: (cb) => {
        aCb = cb;
      },
    },
    b: {
      send: (frame) => aCb?.(frame),
      onFrame: (cb) => {
        bCb = cb;
      },
    },
  };
}

function makeBrowserEndpoint(
  address: string,
  keyPair: KeyPair,
  controlled: boolean,
): PartyEndpoint {
  return {
    address,
    publicKey: keyPair.publicKey,
    scheme: keyPair.scheme,
    sign: controlled ? nobleBackend.makeSigner(keyPair.secretKey) : undefined,
    verify: nobleBackend.makeVerifier(keyPair.publicKey),
  };
}

export class LocalQuantumPokerRuntime {
  readonly userParty: Party = "A";
  readonly botParty: Party = "B";

  private readonly userTunnel: DistributedTunnel<PokerState, PokerMove>;
  private readonly botTunnel: DistributedTunnel<PokerState, PokerMove>;
  private readonly userDriver = new QuantumPokerPersonaDriver(
    this.userParty,
    NARI_PROFILE,
  );
  private readonly botDriver = new QuantumPokerPersonaDriver(
    this.botParty,
    JULES_PROFILE,
  );
  private readonly rng: () => number;
  private nextParty: Party = "A";
  private timestamp = 1n;

  constructor(seed: number) {
    this.rng = mulberry32(seed);
    const keyRng = mulberry32(seed);
    const userKey = keyPairFromRng(keyRng);
    const botKey = keyPairFromRng(keyRng);
    const userAddress = ed25519Address(userKey.publicKey);
    const botAddress = ed25519Address(botKey.publicKey);
    const transport = makeLoopbackTransport();
    const tunnelId = "0x" + "51".repeat(32);
    const balances = { a: 5_000n, b: 5_000n };

    this.userTunnel = new DistributedTunnel(
      new QuantumPokerProtocol(8n),
      {
        tunnelId,
        self: makeBrowserEndpoint(userAddress, userKey, true),
        opponent: makeBrowserEndpoint(botAddress, botKey, false),
        selfParty: this.userParty,
        moveCodec: pokerMoveCodec,
      },
      transport.a,
      balances,
    );
    this.botTunnel = new DistributedTunnel(
      new QuantumPokerProtocol(8n),
      {
        tunnelId,
        self: makeBrowserEndpoint(botAddress, botKey, true),
        opponent: makeBrowserEndpoint(userAddress, userKey, false),
        selfParty: this.botParty,
        moveCodec: pokerMoveCodec,
      },
      transport.b,
      balances,
    );
  }

  snapshot(): QuantumPokerRuntimeSnapshot {
    return {
      state: this.userTunnel.state,
      nonce: this.userTunnel.nonce,
      latest: this.userTunnel.latest,
      stateHash: blake2b256(
        this.userTunnel.protocol.encodeState(this.userTunnel.state),
      ),
      userHoles: this.userDriver.knownHoleCards(this.userTunnel.state),
      botHoles: this.botDriver.knownHoleCards(this.botTunnel.state),
      seatA: this.userDriver.profile,
      seatB: this.botDriver.profile,
    };
  }

  step(): QuantumPokerRuntimeStep | null {
    const order: Party[] = [this.nextParty, this.nextParty === "A" ? "B" : "A"];

    for (const party of order) {
      const tunnel =
        party === this.userParty ? this.userTunnel : this.botTunnel;
      const driver =
        party === this.userParty ? this.userDriver : this.botDriver;
      const move = driver.chooseMove(tunnel.state, this.rng);
      if (!move) continue;
      tunnel.propose(move, this.timestamp++);
      this.nextParty = party === "A" ? "B" : "A";
      const latest = this.userTunnel.latest;
      if (!latest) throw new Error("distributed move did not confirm");
      return { by: party, move, nonce: this.userTunnel.nonce, latest };
    }

    return null;
  }
}

export function createLocalQuantumPokerRuntime(
  seed: number,
): LocalQuantumPokerRuntime {
  return new LocalQuantumPokerRuntime(seed);
}

function mulberry32(seed: number): () => number {
  let value = seed;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
