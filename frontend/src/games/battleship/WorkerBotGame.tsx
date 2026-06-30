/**
 * Worker-hosted solo (bot-battle) view for Battleship — a drop-in for the legacy `BotGame` when
 * `engineEnabled()`. Renders the SAME `BattleView` (and the same `ModeFrame`/`AutoToggle`/`SettleButton`
 * shell) as the legacy path, just fed by the worker `SoloEngine`'s snapshot instead of the main-thread
 * hook: the worker spectates from seat A, so `view` is a full `BattleshipView` (A's real fleet + the
 * public shot results). Autopilot watches; toggling Auto off lets you fire seat A's shots.
 */
import { useEffect } from "react";
import type { ReactNode } from "react";
import { useBattleshipSolo } from "./useBattleshipSolo";
import { BattleView } from "./components/BattleView";
import type { BattleshipView } from "./view";
import {
  ModeFrame,
  AutoToggle,
  SettleButton,
  Centered,
  ErrorPane,
  SettledPane,
  settleLabel,
} from "./BattleshipWindow";

interface Props {
  windowId: string;
  onExit: () => void;
}

export function WorkerBotGame({ windowId, onExit }: Props) {
  const session = useBattleshipSolo(windowId);

  // Auto-start the bot battle on mount (idempotent — the engine only opens one tunnel).
  useEffect(() => {
    if (session.status === "idle") session.start();
  }, [session.status]);

  const view = session.view as BattleshipView | null;
  const live = session.status === "playing";

  let content: ReactNode;
  if (session.status === "error") {
    content = <ErrorPane error={session.error} onBack={onExit} />;
  } else if (session.status === "settling" || session.status === "settled") {
    content = (
      <SettledPane
        score={session.score}
        settling={session.status === "settling"}
        onNewGame={() => session.reset()}
      />
    );
  } else if (session.status === "funding") {
    content = <Centered>Opening + funding the tunnel on-chain…</Centered>;
  } else if (live && view) {
    content = (
      <BattleView
        view={view}
        statusLabel={settleLabel(session.status)}
        onFire={(cell) => session.fire(cell)}
        onPlayAgain={() => session.reset()}
        onSettle={() => session.settleNow()}
        auto={session.auto}
        score={session.score}
        gameNumber={1}
      />
    );
  } else {
    content = <Centered>Starting bot battle…</Centered>;
  }

  const headerExtra = live ? (
    <div className="flex items-center gap-1.5">
      <AutoToggle on={session.auto} onChange={() => session.toggleAuto()} />
      <SettleButton onSettle={() => session.settleNow()} />
    </div>
  ) : undefined;

  return (
    <ModeFrame onBack={onExit} headerExtra={headerExtra}>
      {content}
    </ModeFrame>
  );
}
