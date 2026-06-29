import { memo, useCallback, useMemo } from "react";
import type { ReactNode } from "react";

import { get } from "../games/registry";
import { GameCabinet } from "@/shell/cabinet/GameCabinet";
import {
  TelemetryContext,
  useTelemetry,
  type TelemetryWriter,
} from "@/telemetry/TelemetryProvider";

/**
 * Wraps a game in a telemetry context whose `recordActions` tags this game's `gameId`, so the
 * state updates a game reports (the same `actionsDelta` it ships to the backend heartbeat) are
 * tallied per-game. That per-game tally is what lets the window's TPS chip show a real local
 * rate when the backend's authoritative `perGame` feed is absent. Everything else (snapshot,
 * backend, other writer methods) passes straight through; `report` keeps a stable identity so
 * game effects that depend on it don't churn on each telemetry tick.
 */
function GameTelemetryScope({
  gameId,
  children,
}: {
  gameId: string;
  children: ReactNode;
}) {
  const base = useTelemetry();
  const { report: baseReport, recordGameUpdate } = base;
  const report = useMemo<TelemetryWriter>(
    () => ({
      ...baseReport,
      recordActions: (n) => recordGameUpdate(gameId, n),
    }),
    [baseReport, recordGameUpdate, gameId],
  );
  const value = useMemo(() => ({ ...base, report }), [base, report]);
  return (
    <TelemetryContext.Provider value={value}>
      {children}
    </TelemetryContext.Provider>
  );
}

/**
 * A game's `Window` wrapped in the shared arcade cabinet, memoized so a floor
 * re-render (a sibling drag, a telemetry tick) doesn't re-render this game. Inert
 * for games that don't register a CabinetController yet. Shared by the desktop
 * floor and the phone floor so both mount a game identically.
 *
 * `onClose` takes the windowId (the floor closes by id); the memo holds across
 * re-renders only while `onClose` is stable (the floor passes a memoized setter).
 */
export const GameContent = memo(function GameContent({
  gameId,
  windowId,
  onClose,
}: {
  gameId: string;
  windowId: string;
  onClose: (id: string) => void;
}) {
  const mod = get(gameId);
  const close = useCallback(() => onClose(windowId), [onClose, windowId]);
  if (!mod) return null;
  const Content = mod.Window;
  return (
    <GameTelemetryScope gameId={gameId}>
      <GameCabinet>
        <Content windowId={windowId} onClose={close} />
      </GameCabinet>
    </GameTelemetryScope>
  );
});
