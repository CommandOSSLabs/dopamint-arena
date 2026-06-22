// Reusable backend-gas sponsorship any caller can adopt (ADR-0009). The settler pays gas; the
// sender pays nothing. Generic over the transaction — NOT tunnel-specific: pass any built
// Transaction to `signExec` and it is wrapped in sponsor gas, signed by the wallet, and submitted.
// Whether a given tx is actually sponsored is decided by the BACKEND allowlist (env-configured),
// so this hook never needs to know what it's sponsoring.
import { useMemo } from "react";
import {
  useCurrentAccount,
  useSignTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import {
  makeSponsoredSignExec,
  selectStakeCoin,
  type OwnedCoin,
} from "./sponsor";
import { ensureDopamintStakeCoin, isDopamintConfigured } from "./dopamint";
import type { SignExec } from "./tunnelTx";

export interface SponsoredSignExec {
  /** True once a wallet is connected — there is a sender to sponsor gas for. */
  ready: boolean;
  /**
   * Sponsor + sign + execute ANY transaction: build the tx kind, the backend settler wraps it in
   * its own SIP-58 gas (if the allowlist permits it), the wallet co-signs, both sigs are submitted.
   * Same `(tx) => { digest }` shape as the dapp-kit signer, so it drops into any existing flow.
   */
  signExec: SignExec;
  /**
   * Open/fund helper (optional): pick a user-owned `Coin<SUI>` with at least `minAmount` MIST to
   * fund a stake — gas is sponsored, the stake is not. For self-play funding N seats from one
   * wallet, pass the SUM of the stakes. Unrelated to sponsoring non-tunnel txs.
   */
  selectStakeCoin: (minAmount: bigint) => Promise<string>;
  /**
   * DOPAMINT stake helper (ADR-0010): return a user `Coin<DOPAMINT>` object id with at least
   * `minAmount`. It does NOT faucet — the background top-up ({@link useDopamintAutoFaucet}) keeps
   * the balance above the threshold, so the stake hot-path is just a coin lookup. Throws if the
   * top-up hasn't landed yet (rare cold start) — the caller can retry.
   */
  prepareStake: (minAmount: bigint) => Promise<string>;
}

/** dapp-kit's v1-compat client exposes `getCoins`; typed narrowly to avoid an `any`. */
interface CoinReader {
  getCoins: (input: {
    owner: string;
    coinType?: string;
  }) => Promise<{ data: OwnedCoin[] }>;
}

/**
 * Generic gas sponsorship hook. Drop into ANY component or game flow: replace the wallet
 * `signAndExecuteTransaction` signer for a tx you want gas-sponsored with the returned `signExec`.
 * The backend (`POST /v1/sponsor`, ADR-0009) decides via its env allowlist whether to pay — so a
 * new sponsorable tx type is a backend CONFIG change, never a frontend one. When no wallet is
 * connected `ready` is false and the signer would be rejected; gate the sponsored call on it.
 */
export function useSponsoredSignExec(): SponsoredSignExec {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signTransaction } = useSignTransaction();
  const sender = account?.address ?? "";

  return useMemo(() => {
    const reader = client as unknown as CoinReader;
    const getCoins = (owner: string) =>
      reader.getCoins({ owner }).then((r) => r.data);
    const signExec = makeSponsoredSignExec({
      sender,
      client: client as never,
      signTransaction: signTransaction as never,
    });

    // Stake hot-path: usually the background top-up has already landed a coin and this is a plain
    // lookup. On a cold-start race (fresh wallet, faucet not yet indexed) it faucets via the gas
    // sponsor and polls past indexer lag instead of throwing — so the game open never fails for a
    // just-connected player.
    const prepareStake = (minAmount: bigint): Promise<string> => {
      if (!isDopamintConfigured) {
        throw new Error("DOPAMINT is not configured (VITE_DOPAMINT_* env)");
      }
      return ensureDopamintStakeCoin({
        client: reader as never,
        signExec,
        owner: sender,
        need: minAmount,
      });
    };

    return {
      ready: Boolean(sender),
      signExec,
      selectStakeCoin: (minAmount: bigint) =>
        selectStakeCoin(getCoins, sender, minAmount),
      prepareStake,
    };
  }, [sender, client, signTransaction]);
}
