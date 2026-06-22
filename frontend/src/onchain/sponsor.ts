// Gas-sponsored open/fund via the backend settler (ADR-0009). The settler wraps the user's PTB
// in SIP-58 gas owned by the settler and dry-runs it; the user co-signs the SAME bytes and the
// pair is submitted together. The settler pays gas; the stake stays the user's own coin.
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { resolveBackendUrl } from "@/backend/controlPlane";
import type { SignExec } from "./tunnelTx";

/** dapp-kit's `useSignTransaction` mutateAsync shape: signs a tx, returns the user signature. */
export type WalletSignTransaction = (input: {
  transaction: Transaction;
}) => Promise<{ signature: string; bytes: string }>;

/** The execute surface we need from the app's Sui client (its v1-compat JSON-RPC client). The
 *  same client also resolves inputs for `tx.build` below (passed through structurally). */
export interface SponsorSuiClient {
  executeTransactionBlock(input: {
    transactionBlock: string;
    signature: string[];
    options?: { showEffects?: boolean; showObjectChanges?: boolean };
  }): Promise<{ digest: string }>;
}

interface SponsorResponse {
  txBytes: string;
  sponsorSignature: string;
}

/**
 * A {@link SignExec} that routes the open/fund tx through the backend gas sponsor instead of
 * paying gas from the wallet. Build the PTB KIND → `POST /v1/sponsor` (settler wraps it in its
 * own SIP-58 gas + dry-runs) → user signs the returned bytes → submit with both signatures.
 *
 * Drop-in for the dapp-kit `signAndExecuteTransaction` SignExec: same `(tx) => { digest }` shape,
 * so the open/fund callers don't change. The PTB must fund its stake from a user coin (not the
 * gas coin) — with sponsor gas there is no gas coin to split.
 */
export function makeSponsoredSignExec(opts: {
  sender: string;
  client: SponsorSuiClient;
  signTransaction: WalletSignTransaction;
}): SignExec {
  const root = resolveBackendUrl();
  return async (tx: Transaction) => {
    // 1) Serialize only the PTB — the settler supplies the gas, and sets the sender, itself.
    //    The client resolves input object versions; `as never` bridges the nominal client type.
    const kindBytes = await tx.build({
      client: opts.client as never,
      onlyTransactionKind: true,
    });
    // 2) Sponsor: the settler wraps it in settler-owned gas and rejects (422) anything it won't pay for.
    const res = await fetch(`${root}/v1/sponsor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: opts.sender, txKindBytes: toBase64(kindBytes) }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`sponsor request failed (${res.status}): ${detail}`);
    }
    const { txBytes, sponsorSignature } = (await res.json()) as SponsorResponse;
    // 3) The user co-signs the SAME sponsored bytes (sender authorization).
    const { signature: userSignature, bytes: signedBytes } =
      await opts.signTransaction({
        transaction: Transaction.from(fromBase64(txBytes)),
      });
    // Both signatures must cover identical bytes: the settler signed `txBytes`, so if the wallet
    // re-serialized to anything else the pair is invalid — fail loudly here, not as a cryptic
    // on-chain signature rejection.
    if (signedBytes !== txBytes) {
      throw new Error("sponsored transaction bytes changed during wallet signing");
    }
    // 4) Submit with both sigs: the node verifies the sender (user) and the gas owner (settler).
    const { digest } = await opts.client.executeTransactionBlock({
      transactionBlock: txBytes,
      signature: [userSignature, sponsorSignature],
      options: { showEffects: true, showObjectChanges: true },
    });
    return { digest };
  };
}

/** A coin the wallet owns: id + MIST balance, as returned by `getCoins`. */
export interface OwnedCoin {
  coinObjectId: string;
  balance: string;
}

/**
 * Pick a user-owned `Coin<SUI>` with at least `minAmount` MIST to fund a stake when gas is
 * sponsored — the stake can't come from the gas coin in a SIP-58 sponsored tx. Throws if no
 * single coin is large enough (a fresh 0-SUI zkLogin account still needs stake funds; gas-only).
 */
export async function selectStakeCoin(
  getCoins: (owner: string) => Promise<OwnedCoin[]>,
  owner: string,
  minAmount: bigint,
): Promise<string> {
  const coins = await getCoins(owner);
  const enough = coins.find((c) => BigInt(c.balance) >= minAmount);
  if (!enough) {
    throw new Error(
      `no SUI coin >= ${minAmount} MIST to fund the stake (gas is sponsored, the stake is not)`,
    );
  }
  return enough.coinObjectId;
}
