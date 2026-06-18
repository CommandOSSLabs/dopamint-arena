import { useState } from "react";
import { ConnectButton } from "@mysten/dapp-kit";
import { useCustomWallet } from "@/contexts/CustomWallet";
import { loadOrCreateBots, buildFundTx, FUND_PER_BOT_MIST } from "@/lib/bots";

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
}: {
  bots: { x: bigint; o: bigint };
  onFund: () => void;
  funding: boolean;
  onRefresh: () => Promise<unknown>;
  onRebalance: () => void;
  rebalancing: boolean;
  locked: boolean;
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
    <div className="flex flex-col sm:flex-row sm:items-center justify-between py-2 border-b border-primary/10">
      <div className="flex items-center gap-2">
        <span className={`font-headline-lg text-lg ${color}`}>{label}</span>
        <span className="font-body-lg text-xl border border-primary/20 rounded-full px-2 py-0.5 leading-none bg-surface-container-low">{marker}</span>
      </div>
      <div className="flex items-center gap-4 mt-1 sm:mt-0 font-label-sm text-sm">
        <span className="text-outline border-b border-dashed border-outline/35 pb-0.5" title={address}>{short(address)}</span>
        <span className="text-primary font-bold tabular-nums bg-tertiary-container/20 px-2 py-0.5 rounded-sm">{fmtSui(balance)} SUI</span>
      </div>
    </div>
  );

  return (
    <div className="w-full max-w-md bg-surface-container-lowest border-[2px] border-primary p-4 shadow-[4px_4px_0px_#00336615] flex flex-col gap-4 rounded-sm relative z-10">
      <div className="flex flex-col gap-1">
        <Row label="Bot X" address={ids.x.address} balance={bots.x} color="text-primary" marker="X" />
        <Row label="Bot O" address={ids.o.address} balance={bots.o} color="text-secondary" marker="O" />
      </div>

      <div className="flex flex-col gap-2 mt-2">
        {(bots.x > 0n || bots.o > 0n) && (
          <button
            onClick={onRebalance}
            disabled={rebalancing || locked}
            title="Move half the difference from the richer bot to the poorer one"
            className="w-full py-2 border-2 border-primary bg-surface font-headline-lg-mobile text-sm hover:bg-primary/5 active:translate-y-[1px] disabled:opacity-40 disabled:cursor-not-allowed transition-all text-primary rounded-sm shadow-[2px_2px_0px_#001e40]"
          >
            {rebalancing ? "Balancing…" : "⇄ Even out bots"}
          </button>
        )}

        {isConnected ? (
          <button
            onClick={fundFromWallet}
            disabled={walletFunding}
            className="w-full py-2 bg-primary text-on-primary font-headline-lg-mobile text-sm hover:bg-primary-container active:translate-y-[1px] disabled:opacity-40 disabled:cursor-not-allowed transition-all rounded-sm shadow-[2px_2px_0px_#bc0000]"
          >
            {walletFunding ? "Funding…" : `Fund bots from wallet (${totalSui} SUI)`}
          </button>
        ) : (
          <div className="flex flex-col sm:flex-row gap-2 mt-1 [&_button]:w-full [&_button]:py-2 [&_button]:px-4 [&_button]:border-2 [&_button]:border-primary [&_button]:rounded-sm [&_button]:font-headline-lg-mobile [&_button]:text-primary [&_button]:bg-surface [&_button]:hover:bg-primary/5 [&_button]:transition-all [&_button]:text-xs [&_button]:shadow-[2px_2px_0px_#001e40]">
            <ConnectButton connectText="Connect wallet" />
            <button
              onClick={login}
              className="w-full py-2 px-4 border-2 border-primary bg-surface text-primary font-headline-lg-mobile text-xs hover:bg-primary/5 transition-all rounded-sm flex items-center justify-center gap-1 shadow-[2px_2px_0px_#001e40]"
            >
              <span className="material-symbols-outlined text-sm">login</span>
              Google
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-xs font-label-sm border-t border-dashed border-primary/20 pt-2">
        <button
          onClick={onFund}
          disabled={funding}
          className="text-outline hover:text-primary underline transition-colors disabled:opacity-40"
        >
          {funding ? "Requesting faucet…" : "or try testnet faucet"}
        </button>
        {isConnected && (
          <button onClick={logout} className="text-outline hover:text-secondary underline transition-colors">
            disconnect
          </button>
        )}
      </div>

      {err && (
        <div className="text-secondary font-label-sm text-xs break-words border border-secondary/20 bg-secondary/5 p-2 rounded-sm italic">
          * Error: {err}
        </div>
      )}
    </div>
  );
}
