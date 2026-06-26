import { memo, useCallback } from "react";

import { get } from "../games/registry";
import { GameCabinet } from "@/shell/cabinet/GameCabinet";

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
    <GameCabinet>
      <Content windowId={windowId} onClose={close} />
    </GameCabinet>
  );
});
