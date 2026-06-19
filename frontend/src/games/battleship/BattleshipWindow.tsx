import { useEffect, useState, type ReactNode } from "react";
import { registerWindowDisposer } from "@/lib/windowSessions";
import type { GameWindowProps } from "../types";
import { PlacementBoard } from "./components/PlacementBoard";
import { BattleView } from "./components/BattleView";
import { useBattleship } from "./useBattleship";
import { useBattleshipPvp } from "./useBattleshipPvp";

type Mode = "bot" | "pvp";

// Which mode a window is in, kept by windowId so a remount (minimize / maximize /
// desktop reflow) returns to the live game rather than the chooser. Cleared on close.
const modeStore = new Map<string, Mode | null>();

/**
 * Battleship over a REAL Sui tunnel. Place a fleet, then fight a bot (one wallet
 * opens + funds a self-play tunnel, or a no-wallet off-chain demo) or match a real
 * opponent (PvP over the relay). Every shot is commit-revealed and co-signed; the
 * result settles on-chain. The session lives in a windowId-keyed store, so
 * minimizing or resizing the window never drops the game. ADR 0003.
 */
export function BattleshipWindow({ windowId }: GameWindowProps) {
  const [mode, setModeState] = useState<Mode | null>(
    () => modeStore.get(windowId) ?? null,
  );
  useEffect(() => {
    registerWindowDisposer(windowId, "battleship-mode", () =>
      modeStore.delete(windowId),
    );
  }, [windowId]);
  const setMode = (m: Mode | null) => {
    if (m === null) modeStore.delete(windowId);
    else modeStore.set(windowId, m);
    setModeState(m);
  };

  // One size-container for the whole game so every pane sizes off the WINDOW's
  // width AND height (container queries + cqh units), not the viewport — correct
  // in a small floating window on a big screen, or full-width on mobile.
  return (
    <div className="h-full min-h-0 [container-type:size]">
      {mode === "bot" ? (
        <BotGame windowId={windowId} onExit={() => setMode(null)} />
      ) : mode === "pvp" ? (
        <PvpGame windowId={windowId} onExit={() => setMode(null)} />
      ) : (
        <ModeChooser onPick={setMode} />
      )}
    </div>
  );
}

function ModeChooser({ onPick }: { onPick: (m: Mode) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-sm text-arena-muted">
        Hide a fleet, then sink your foe's. Each shot is{" "}
        <span className="text-arena-accent">commit-revealed</span> and co-signed
        in the tunnel; winner takes 100 on-chain.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          onClick={() => onPick("bot")}
          className="rounded bg-arena-accent px-4 py-2 text-sm font-semibold text-black"
        >
          Play vs Bot
        </button>
        <button
          onClick={() => onPick("pvp")}
          className="rounded border border-arena-edge px-4 py-2 text-sm font-semibold text-arena-text hover:bg-arena-edge"
        >
          Find Match (PvP)
        </button>
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-arena-muted">
      {children}
    </div>
  );
}

function ErrorPane({
  error,
  onBack,
}: {
  error: string | null;
  onBack: () => void;
}) {
  return (
    <Centered>
      <p className="text-red-400">{error ?? "something went wrong"}</p>
      <button
        onClick={onBack}
        className="rounded border border-arena-edge px-3 py-1.5 text-sm text-arena-text"
      >
        Back
      </button>
    </Centered>
  );
}

function settleLabel(status: string): string | undefined {
  if (status === "settling") return "settling on-chain…";
  if (status === "settled") return "settled ✓";
  return undefined;
}

function BotGame({
  windowId,
  onExit,
}: {
  windowId: string;
  onExit: () => void;
}) {
  const { status, view, error, startBattle, fire, reset } =
    useBattleship(windowId);

  if (status === "error") {
    return (
      <ErrorPane
        error={error}
        onBack={() => {
          reset();
          onExit();
        }}
      />
    );
  }
  if (status === "funding") {
    return (
      <Centered>
        Opening + funding the tunnel on-chain… approve in your wallet.
      </Centered>
    );
  }
  if (!view || status === "idle" || status === "placing") {
    return <PlacementBoard onReady={startBattle} />;
  }
  return (
    <BattleView
      view={view}
      statusLabel={settleLabel(status)}
      onFire={fire}
      onPlayAgain={reset}
    />
  );
}

function PvpGame({
  windowId,
  onExit,
}: {
  windowId: string;
  onExit: () => void;
}) {
  const { status, view, error, opponentWallet, findMatch, fire, reset } =
    useBattleshipPvp(windowId);

  if (status === "error") {
    return (
      <ErrorPane
        error={error}
        onBack={() => {
          reset();
          onExit();
        }}
      />
    );
  }
  if (status === "idle") {
    return <PlacementBoard onReady={findMatch} ctaLabel="Find Match" />;
  }
  if (status === "matching" || status === "funding" || !view) {
    return (
      <Centered>
        <div>
          {status === "matching"
            ? "Finding an opponent…"
            : status === "funding"
              ? "Opening + funding the tunnel on-chain… approve in your wallet."
              : "Setting up…"}
        </div>
        {opponentWallet && (
          <div className="text-[11px]">vs {opponentWallet.slice(0, 10)}…</div>
        )}
      </Centered>
    );
  }
  return (
    <BattleView
      view={view}
      statusLabel={settleLabel(status)}
      onFire={fire}
      onPlayAgain={() => {
        reset();
        onExit();
      }}
    />
  );
}
