import { useCallback, useEffect, useRef } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { useSoloCabinet } from "@/shell/cabinet/soloCabinet";
import type { GameWindowProps } from "../types";
import { useQuantumPokerSolo } from "./useQuantumPokerSolo";
import { PokerActionBar } from "./PokerActionBar";
import { QuantumPokerTable } from "./QuantumPokerTable";
import { SketchDefs } from "../sketch";

function Stat({ n, l }: { n: number | string; l: string }) {
  return (
    <span className="qp-stat">
      <span className="qp-stat__n tabular-nums">{n}</span>
      <span className="qp-stat__l">{l}</span>
    </span>
  );
}

export function QuantumPokerBotVsBotWindow({
  windowId,
  onExit,
  autoTakeOver = false,
}: GameWindowProps & { onExit?: () => void; autoTakeOver?: boolean }) {
  const s = useQuantumPokerSolo(windowId);
  const account = useCurrentAccount();
  const running = s.status === "running";
  const funding = s.status === "funding";
  const nameA = s.personas?.a ?? "Bot A";
  const nameB = s.personas?.b ?? "Bot B";

  // "Play vs Bot" entry: take seat A once, immediately. Latches at/​before the
  // first dealt hand, so no further wiring is needed.
  const took = useRef(false);
  useEffect(() => {
    if (autoTakeOver && !took.current) {
      took.current = true;
      s.takeOver();
    }
  }, [autoTakeOver, s.takeOver]);

  // Shared arcade-cabinet seam (PR #47 `useSoloCabinet` primitive): the shell owns hover → pause →
  // overlay and the corner Home button; this window only supplies the verbs. goManual = take seat A
  // (cosmetic, same tunnel — `takeOver` is idempotent); goHome = drop the seat + return to the menu.
  // Offerable only while the bots auto-play (funded, running, not yet taken over, with live state).
  const goHome = useCallback(() => {
    s.returnHome();
    onExit?.();
  }, [s.returnHome, onExit]);
  useSoloCabinet({
    offerable:
      !!account && s.funded && s.status === "running" && !s.manual && !!s.state,
    pause: s.pause,
    resume: s.resume,
    goManual: s.takeOver,
    goHome,
  });

  return (
    <div className="sketch grid h-full min-h-[14rem] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
      <SketchDefs />

      <header className="qp-head">
        <div className="flex min-w-0 items-center gap-[clamp(6px,2.2cqmin,14px)]">
          {onExit && (
            <button
              type="button"
              className="sketch-btn"
              onClick={() => {
                s.returnHome(); // reset take-over so a later "Watch Bots" starts clean
                s.stopAuto(); // fire-and-forget settle: closes the current tunnel in the background, leave now
                onExit();
              }}
            >
              Back
            </button>
          )}
          <div className="flex min-w-0 flex-col leading-none">
            <span className="sketch-eyebrow">
              {s.manual
                ? s.autoSeat
                  ? "Auto · bot plays your seat"
                  : "Your seat · vs bot"
                : "Auto · watching bots"}
            </span>
            <span className="qp-title truncate">Quantum Poker</span>
          </div>
        </div>
        {s.manual ? (
          <button
            type="button"
            className={`sketch-btn${s.autoSeat ? " sketch-btn--go" : ""}`}
            onClick={() => s.setAutoSeat(!s.autoSeat)}
            title={
              s.autoSeat
                ? "Auto on — a bot is playing your seat"
                : "Let a bot play your seat"
            }
          >
            🤖 Auto{s.autoSeat ? " ON" : ""}
          </button>
        ) : running ? (
          <div className="flex items-center gap-[clamp(6px,2.2cqmin,14px)]">
            <button
              type="button"
              className="sketch-btn sketch-btn--go"
              onClick={s.takeOver}
            >
              Play vs Bot
            </button>
            <button
              type="button"
              className="sketch-btn sketch-btn--stop"
              onClick={s.stopAuto}
            >
              Stop
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="sketch-btn sketch-btn--go"
            onClick={s.startAuto}
            disabled={!account || !s.funded || funding}
          >
            Start
          </button>
        )}
      </header>

      <main className="grid min-h-0 overflow-hidden p-[clamp(10px,3.6cqmin,36px)]">
        {!account ? (
          <div className="grid place-items-center text-center">
            <div className="sketch-panel sketch-stroke max-w-[min(22rem,92%)] p-[clamp(12px,3.4cqmin,24px)]">
              <span className="sketch-eyebrow">Wallet required</span>
              <div className="qp-title mb-1 mt-1">Connect to watch</div>
              <p className="sketch-note">
                Connect a wallet to run the bot arena — gas is sponsored, so
                watching the bots play is free.
              </p>
            </div>
          </div>
        ) : !s.funded ? (
          <div className="grid place-items-center text-center">
            <div className="sketch-panel sketch-stroke max-w-[min(22rem,92%)] p-[clamp(12px,3.4cqmin,24px)]">
              <div className="qp-title mb-1">Fund bot A</div>
              <p className="sketch-note mb-3">
                Bot A stakes both seats and signs each open; bot B collects its
                winnings at the close and never needs funding.
              </p>
              <div className="flex flex-wrap justify-center gap-[clamp(6px,2cqmin,12px)]">
                <button
                  type="button"
                  className="sketch-btn sketch-btn--go"
                  onClick={s.fund}
                  disabled={funding}
                >
                  {funding ? "Funding…" : "Faucet"}
                </button>
                {s.canFundFromWallet && (
                  <button
                    type="button"
                    className="sketch-btn"
                    onClick={s.fundFromWallet}
                    disabled={funding}
                  >
                    Wallet · 0.1 SUI
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : s.state ? (
          <QuantumPokerTable
            state={s.state}
            holesA={s.holesA}
            holesB={s.holesB}
            nameA={s.manual ? "You" : nameA}
            nameB={nameB}
          />
        ) : (
          <div className="grid place-items-center">
            <span className="sketch-note">Dealing the first hand…</span>
          </div>
        )}
      </main>

      {s.manual && s.legal && s.state && (
        <div className="qp-actions px-[clamp(8px,2.4cqmin,18px)] pb-[clamp(6px,1.8cqmin,12px)]">
          <PokerActionBar
            legal={s.legal}
            pot={s.state.totalBetA + s.state.totalBetB}
            onAct={s.act}
            secondsLeft={s.secondsLeft}
          />
        </div>
      )}

      <footer className="qp-ticker">
        <span className="qp-stat">
          <span className="qp-stat__n">
            {nameA} {s.score.a}
          </span>
          <span className="qp-stat__l">–</span>
          <span className="qp-stat__n">
            {s.score.b} {nameB}
          </span>
        </span>
        <span className="qp-dot">·</span>
        <Stat n={s.hands} l="hands" />
        <span className="qp-dot">·</span>
        <Stat n={s.actions} l="actions" />
        <span className="qp-dot">·</span>
        <Stat n={s.tunnels} l="tunnels" />
        <span className="qp-dot">·</span>
        <Stat n={s.status} l="" />
      </footer>

      {s.error && (
        <div className="px-[clamp(8px,2.4cqmin,18px)] pb-2 text-[clamp(10px,2.6cqmin,15px)] text-[var(--sketch-red)]">
          {s.error}
        </div>
      )}
    </div>
  );
}
