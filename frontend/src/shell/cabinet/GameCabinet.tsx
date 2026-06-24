import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
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
  const stageRef = useRef<HTMLDivElement>(null);
  // Read the controller from a ref inside the global pointer listener (below) so that
  // listener is (re)subscribed only when `active` flips — NOT every time the game
  // rebuilds its controller (which churns on each phase/score change). Keeps a
  // window-level pointermove listener from being torn down + re-added mid-play.
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  // Freeze the self-playing demo while the pointer is anywhere over THIS window — the game
  // content OR the resize handles Desktop rings around its edges. Otherwise the ~80fps
  // self-play loop keeps repainting under the cursor, and on the thin resize edges that
  // repaint makes the OS resize cursor flicker. We track the pointer against the window's
  // rect (+ a small margin so the edge/corner handles on the rim count as "over"), which
  // is independent of where Desktop mounts its float vs. grid handles. The take-over
  // overlay still only appears for the content (onEnter), so reaching an edge to resize
  // frees the cursor without popping the overlay; leaving the window resumes + dismisses.
  useEffect(() => {
    if (!active) return;
    const win = stageRef.current?.closest("[data-window]");
    if (!win) return;
    const HANDLE_MARGIN = 18;
    let inside = false;
    let frame = 0;
    let lastX = 0;
    let lastY = 0;
    const evaluate = () => {
      const r = win.getBoundingClientRect();
      const over =
        lastX >= r.left - HANDLE_MARGIN &&
        lastX <= r.right + HANDLE_MARGIN &&
        lastY >= r.top - HANDLE_MARGIN &&
        lastY <= r.bottom + HANDLE_MARGIN;
      if (over === inside) return;
      inside = over;
      if (over) {
        controllerRef.current?.pause();
      } else {
        controllerRef.current?.resume();
        dispatch({ type: "unhover" });
      }
    };
    const onMove = (e: PointerEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (frame) return; // coalesce to one rect-check per frame
      frame = requestAnimationFrame(() => {
        frame = 0;
        evaluate();
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
      if (inside) {
        controllerRef.current?.resume();
        dispatch({ type: "unhover" });
      }
    };
  }, [active]);

  // The take-over overlay appears only when hovering the game CONTENT (this stage), never
  // the surrounding chrome/handles — reaching for a resize edge must not pop it. Pause is
  // redundant with the window tracker above, but keeps the overlay working if a cabinet is
  // ever mounted outside a [data-window] (no tracker). Dismissal is owned by the tracker.
  const onEnter = useCallback(() => {
    if (active && model.state === "attract") {
      controller?.pause();
      dispatch({ type: "hover" });
    }
  }, [active, controller, model.state]);

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
        ref={stageRef}
        className={`shell-stage shell-${model.state}`}
        onMouseEnter={onEnter}
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
