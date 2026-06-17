import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { core, onchain, protocols } from "sui-tunnel-ts";
import { encodeStateHash, buildStateUpdateMsg, buildSettlementMsg } from "@ttt/shared";

// Near-zero-stake game (stake 0): balances stay 1/1 throughout, the board is the only state.
export const proto = new protocols.TicTacToeProtocol(0n);

export function newGameKey() {
  return core.generateKeyPair();
}

export interface PartyInput {
  address: string;
  publicKey: Uint8Array;
}

// The SDK's onchain.* builders expect a Transaction from @mysten/sui@1.28.1 (the SDK's pin);
// the client uses @mysten/sui@1.45.2. The two Transaction classes are structurally
// incompatible (private fields), so cast ONLY at this builder boundary. The built bytes are
// identical — the cast is type-only. (Same pattern as CustomWallet's sign/build calls.)
type SdkTx = Parameters<typeof onchain.buildUpdateState>[0];

const PACKAGE_ID = import.meta.env.VITE_TTT_PACKAGE_ID as string;

// Open + fund (both stakes) + activate the tunnel in ONE PTB via the framework's
// `tunnel::create_and_fund` extension. The single signer (bot X) supplies BOTH 1-MIST stakes
// from its own gas coin, so bot O signs nothing on-chain and the old 3-tx open (create_and_share
// + deposit X + deposit O) collapses to one signature. At cooperative close both stakes return
// to their parties by the co-signed final balances.
//
// Built as a raw moveCall (mirroring the SDK's onchain.buildCreateAndFund) rather than via the
// SDK helper, so it works regardless of whether this client's pinned SDK build exports it.
export function buildCreateAndFundTx(
  partyA: PartyInput,
  partyB: PartyInput,
  stake: bigint,
): Transaction {
  const tx = new Transaction();
  const [coinA, coinB] = tx.splitCoins(tx.gas, [stake, stake]);
  tx.moveCall({
    target: `${PACKAGE_ID}::tunnel::create_and_fund`,
    typeArguments: ["0x2::sui::SUI"],
    arguments: [
      tx.pure.address(partyA.address),
      tx.pure.vector("u8", Array.from(partyA.publicKey)),
      tx.pure.u8(core.SignatureScheme.ED25519),
      tx.pure.address(partyB.address),
      tx.pure.vector("u8", Array.from(partyB.publicKey)),
      tx.pure.u8(core.SignatureScheme.ED25519),
      coinA,
      coinB,
      tx.pure.u64(86400000n),
      tx.pure.u64(0n),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// Checkpoint the FINAL co-signed state on-chain (`entry_update_state`): writes the state field
// (nonce, final balances, state_hash) so the tunnel object reflects the played-out state — not
// the empty opening. Submitted right before the root close, so the object carries the final
// state_hash while the close event anchors the full-history transcript root. Requires the
// update's timestamp >= created_at (each step is signed with created_at; see useBotGame).
export function buildUpdateStateTx(
  tunnelId: string,
  u: {
    update: {
      stateHash: Uint8Array;
      nonce: bigint;
      partyABalance: bigint;
      partyBBalance: bigint;
      timestamp: bigint;
    };
    sigA: Uint8Array;
    sigB: Uint8Array;
  },
): Transaction {
  const tx = new Transaction();
  onchain.buildUpdateState(tx as unknown as SdkTx, {
    tunnelId,
    stateHash: u.update.stateHash,
    nonce: u.update.nonce,
    partyABalance: u.update.partyABalance,
    partyBBalance: u.update.partyBBalance,
    timestamp: u.update.timestamp,
    sigA: u.sigA,
    sigB: u.sigB,
    coinType: "0x2::sui::SUI",
  });
  return tx;
}

// Close cooperatively AND anchor the off-chain transcript Merkle root in one tx
// (`entry_close_cooperative_with_root`): distributes funds by the co-signed final balances and
// commits the 32-byte root over EVERY co-signed update, compressing the full play history to a
// single on-chain commitment. The dual signatures are over the settlement-with-root message.
// Submitted after `update_state`, so both the final state_hash (object field) and the full
// transcript root (close event) end up on-chain.
export function buildSettleWithRootTx(
  tunnelId: string,
  s: core.CoSignedSettlementWithRoot,
): Transaction {
  const tx = new Transaction();
  onchain.buildCloseWithRootFromSettlement(tx as unknown as SdkTx, tunnelId, s, "0x2::sui::SUI");
  return tx;
}

export { encodeStateHash, buildStateUpdateMsg, buildSettlementMsg, core };
export const parseTunnelId = onchain.parseTunnelId;
