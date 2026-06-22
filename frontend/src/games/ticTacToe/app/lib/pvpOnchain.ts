// frontend/src/games/ticTacToe/packages/client/src/lib/pvpOnchain.ts
import { Transaction } from "@mysten/sui/transactions";
import { core, onchain } from "sui-tunnel-ts";

const SUI = "0x2::sui::SUI";
// SDK builders are typed against the SDK's pinned @mysten/sui; the client uses a newer one. The
// built bytes are identical — cast only at this boundary (same pattern as lib/tunnel.ts).
type SdkTx = Parameters<typeof onchain.buildCreateAndShare>[0];

export interface PvpParty {
  walletAddress: string;
  publicKey: Uint8Array;
}

/** Open + share the tunnel registering both parties (the opener pays the trivial create gas). */
export function buildCreateAndShareTx(
  a: PvpParty,
  b: PvpParty,
  penaltyAmount: bigint,
): Transaction {
  const tx = new Transaction();
  onchain.buildCreateAndShare(tx as unknown as SdkTx, {
    partyA: {
      address: a.walletAddress,
      publicKey: a.publicKey,
      signatureType: core.SignatureScheme.ED25519,
    },
    partyB: {
      address: b.walletAddress,
      publicKey: b.publicKey,
      signatureType: core.SignatureScheme.ED25519,
    },
    timeoutMs: 86_400_000n,
    penaltyAmount,
  });
  return tx;
}

/**
 * Fund this seat's bankroll. With `stakeCoinId` the stake splits off that user coin (DOPAMINT /
 * gas-sponsored path — a sponsored tx has no gas coin to split); without it, off the gas coin
 * (SUI fallback). `coinType` selects the staked token (defaults to SUI).
 */
export function buildDepositTx(
  tunnelId: string,
  amount: bigint,
  opts?: { coinType?: string; stakeCoinId?: string },
): Transaction {
  const tx = new Transaction();
  if (opts?.stakeCoinId) {
    const [coin] = tx.splitCoins(tx.object(opts.stakeCoinId), [
      tx.pure.u64(amount),
    ]);
    onchain.buildDeposit(tx as unknown as SdkTx, {
      tunnelId,
      coin,
      coinType: opts.coinType,
    });
  } else {
    onchain.buildDepositFromGas(tx as unknown as SdkTx, { tunnelId, amount });
  }
  return tx;
}

/** Cooperative close from the dual-signed settlement (combineSettlement output). */
export function buildCloseTx(
  tunnelId: string,
  settlement: core.CoSignedSettlement,
  coinType: string = SUI,
): Transaction {
  const tx = new Transaction();
  onchain.buildCloseFromSettlement(
    tx as unknown as SdkTx,
    tunnelId,
    settlement,
    coinType,
  );
  return tx;
}

/** Root-anchored cooperative close from the dual-signed settlement with root. */
export function buildCloseWithRootTx(
  tunnelId: string,
  settlement: core.CoSignedSettlementWithRoot,
  coinType: string = SUI,
): Transaction {
  const tx = new Transaction();
  onchain.buildCloseWithRootFromSettlement(
    tx as unknown as SdkTx,
    tunnelId,
    settlement,
    coinType,
  );
  return tx;
}

export const parseTunnelId = onchain.parseTunnelId;
