import { useCallback, useMemo, useReducer, useState } from "react";
import type { ReactNode } from "react";
import "../shell.css";
import { reduce, INITIAL } from "../seatControlState";
import { CabinetContext } from "./CabinetContext";
import { TakeOverOverlay } from "./TakeOverOverlay";
import type { CabinetController } from "./CabinetController";

/**
 * Shared arcade-cabinet shell. Wrap a game's window root in this; the game's App
 * registers a `CabinetController` (`useRegisterCabinet`) and the shell layers the
 * universal UX on top:
 *   - hovering a live, auto-playing cabinet freezes it and reveals the overlay,
 *   - "Play vs Bot" hands control to the human,
 *   - "Return to Home" sends the game back to its own home screen.
 *
 * The shell is game-agnostic — it only owns the hover + overlay + state machine
 * and calls the controller's verbs. A new game adopts it by wrapping its own
 * window and registering a controller; nothing here is ttt-specific.
 */
export function GameCabinet({ children }: { children: ReactNode }) {
  const [controller, setController] = useState<CabinetController | null>(null);
  const [model, dispatch] = useReducer(reduce, INITIAL);
  const registry = useMemo(() => ({ register: setController }), []);

  const active = controller?.active ?? false;

  const onEnter = useCallback(() => {
    if (active && model.state === "attract") {
      controller?.pause();
      dispatch({ type: "hover" });
    }
  }, [active, controller, model.state]);

  const onLeave = useCallback(() => {
    if (model.state === "inviting") {
      controller?.resume();
      dispatch({ type: "unhover" });
    }
  }, [controller, model.state]);

  const onPlay = useCallback(() => {
    controller?.takeOver();
    dispatch({ type: "takeOver" });
  }, [controller]);

  // "Return to Home" (overlay) and the in-game ⌂ both send the game back to its own home
  // screen. (Just moving the mouse away resumes the demo — see onLeave.)
  const onHome = useCallback(() => {
    controller?.returnHome();
    dispatch({ type: "goHome" });
  }, [controller]);

  return (
    <CabinetContext.Provider value={registry}>
      <div
        className={`shell-stage shell-${model.state}`}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        <div className="shell-board">{children}</div>
        {/* No auto/attract badge here — each game owns its own auto indicator (e.g. ttt's
            GameScene Auto toggle). The shell only adds the hover overlay + state machine. */}
        {model.state === "inviting" && (
          <TakeOverOverlay onPlay={onPlay} onHome={onHome} />
        )}
        {model.state === "live" && (
          <button className="shell-home-btn" onClick={onHome}>
            ⌂ Home
          </button>
        )}
      </div>
    </CabinetContext.Provider>
  );
}
