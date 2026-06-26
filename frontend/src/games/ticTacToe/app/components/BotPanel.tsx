import { useState } from "react";

import { useCustomWallet } from "@/games/ticTacToe/app/contexts/CustomWallet";
import {
  loadOrCreateBots,
  buildFundTx,
  FUND_PER_BOT_MIST,
} from "@/games/ticTacToe/app/lib/bots";
import { isMtpsConfigured } from "@/onchain/mtps";

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// MIST (1e9) -> SUI string, trimmed.
function fmtSui(mist: bigint): string {
  const whole = mist / 1_000_000_000n;
  const frac = mist % 1_000_000_000n;
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function BotPanel({
  bots,
  onFund,
  funding,
  onRefresh,
  onRebalance,
  rebalancing,
  locked,
  isPortrait = false,
}: {
  bots: { x: bigint; o: bigint };
  onFund: () => void;
  funding: boolean;
  onRefresh: () => Promise<unknown>;
  onRebalance: () => void;
  rebalancing: boolean;
  locked: boolean;
  isPortrait?: boolean;
}) {
  // Addresses are stable for the lifetime of the page; derive once for display.
  const ids = loadOrCreateBots();
  const { isConnected, login, logout, executeTransaction } = useCustomWallet();
  const [walletFunding, setWalletFunding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const totalSui = (FUND_PER_BOT_MIST * 2) / 1_000_000_000;

  const fundFromWallet = async () => {
    setWalletFunding(true);
    setErr(null);
    try {
      // One tx: send FUND_PER_BOT_MIST to each bot from the connected wallet's gas coin.
      await executeTransaction({ tx: buildFundTx(ids) });
      await onRefresh();
      await wait(1500); // give the fullnode a moment, then refresh once more
      await onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setWalletFunding(false);
    }
  };

  const Row = ({
    label,
    address,
    balance,
    color,
    marker,
  }: {
    label: string;
    address: string;
    balance: bigint;
    color: string;
    marker: string;
  }) => (
    <div
      className={`flex items-center justify-between border-b-2 border-[var(--qp-ink-soft)]/20 ${isPortrait ? "py-2" : "py-4"}`}
    >
      <div className="flex items-center gap-2 sm:gap-4">
        <span
          className={`font-headline-lg ${isPortrait ? "text-lg" : "text-3xl"} ${color}`}
        >
          {label}
        </span>
        <span
          className={`font-body-lg border-2 border-[var(--qp-ink-soft)]/40 rounded-full leading-none bg-[var(--qp-paper)] ${isPortrait ? "text-sm px-2 py-0.5" : "text-3xl px-4 py-1"}`}
        >
          {marker}
        </span>
      </div>
      <div
        className={`flex items-center mt-0 sm:mt-0 font-label-sm ${isPortrait ? "text-sm gap-2" : "text-2xl gap-6"}`}
      >
        <span
          className="text-outline border-b-2 border-dashed border-outline/35 pb-0.5"
          title={address}
        >
          {short(address)}
        </span>
        {/* MTPS mode: bots play free (sponsored gas + faucet stake) — hide the SUI balance. */}
        {!isMtpsConfigured && (
          <span
            className={`text-primary font-bold tabular-nums bg-tertiary-container/20 rounded-lg ${isPortrait ? "px-2 py-1 text-xs" : "px-4 py-2 text-2xl"}`}
          >
            {fmtSui(balance)} SUI
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div
      className={`qp-panel qp-stroke w-full h-full flex-1 justify-center flex flex-col relative z-10 ${isPortrait ? "p-4 gap-4" : "p-12 gap-8"}`}
    >
      <div className={`flex flex-col ${isPortrait ? "gap-2" : "gap-6"}`}>
        <Row
          label="Bot X"
          address={ids.x.address}
          balance={bots.x}
          color="text-primary"
          marker="X"
        />
        <Row
          label="Bot O"
          address={ids.o.address}
          balance={bots.o}
          color="text-secondary"
          marker="O"
        />
      </div>

      <div className={`flex flex-col mt-4 ${isPortrait ? "gap-3" : "gap-6"}`}>
        {/* MTPS mode: bots play free (sponsored gas + faucet stake), so SUI-gas funding —
            rebalance + wallet-fund — is unnecessary; hide it. Connect/login stays for PvP. */}
        {!isMtpsConfigured && (bots.x > 0n || bots.o > 0n) && (
          <button
            onClick={onRebalance}
            disabled={rebalancing || locked}
            title="Move half the difference from the richer bot to the poorer one"
            className={`w-full bg-[var(--qp-paper)] font-bold uppercase tracking-widest hover:bg-[var(--qp-ink)]/5 active:translate-y-[2px] disabled:opacity-40 disabled:cursor-not-allowed transition-all text-[var(--qp-ink)] rounded-xl border border-[var(--qp-ink)] shadow-[4px_4px_0px_var(--qp-ink)] ${isPortrait ? "py-3 text-lg border-4" : "py-6 text-3xl border-[4px]"}`}
          >
            {rebalancing ? "Balancing…" : "⇄ Even out bots"}
          </button>
        )}

        {isConnected ? (
          !isMtpsConfigured && (
            <button
              onClick={fundFromWallet}
              disabled={walletFunding}
              data-testid="ttt-fund-wallet"
              className={`w-full bg-primary text-on-primary font-headline-lg-mobile hover:bg-primary-container active:translate-y-[2px] disabled:opacity-40 disabled:cursor-not-allowed transition-all rounded-xl shadow-[4px_4px_0px_#bc0000] ${isPortrait ? "py-3 text-lg" : "py-6 text-3xl"}`}
            >
              {walletFunding
                ? "Funding…"
                : `Fund bots from wallet (${totalSui} SUI)`}
            </button>
          )
        ) : (
          <p className="text-center text-lg md:text-xl text-[var(--qp-red)] font-bold pt-3 uppercase tracking-widest mt-4">
            Please connect your Sui wallet in the top bar to fund bots.
          </p>
        )}
      </div>

      <div
        className={`flex items-center justify-between font-label-sm border-t-4 border-dashed border-[var(--qp-ink-soft)]/40 mt-4 ${isPortrait ? "text-sm pt-3" : "text-2xl pt-6"}`}
      >
        {/* The SUI testnet faucet is irrelevant in MTPS mode (the stake is faucet-minted). */}
        {!isMtpsConfigured ? (
          <button
            onClick={onFund}
            disabled={funding}
            className="text-outline hover:text-primary underline transition-colors disabled:opacity-40"
          >
            {funding ? "Requesting faucet…" : "or try testnet faucet"}
          </button>
        ) : (
          <span />
        )}
        {isConnected && (
          <button
            onClick={logout}
            className="text-outline hover:text-secondary underline transition-colors"
          >
            disconnect
          </button>
        )}
      </div>

      {err && (
        <div
          className={`text-secondary font-label-sm break-words border-4 border-secondary/20 bg-secondary/5 rounded-xl italic ${isPortrait ? "p-3 text-sm" : "p-6 text-2xl"}`}
        >
          * Error: {err}
        </div>
      )}
    </div>
  );
}
