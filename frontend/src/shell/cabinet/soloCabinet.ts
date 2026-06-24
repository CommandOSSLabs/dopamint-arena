import { useMemo } from "react";
import type { CabinetController } from "./CabinetController";
import { useRegisterCabinet } from "./CabinetContext";

/** A window's top-level mode; the cabinet is offerable only in a self-play mode. */
export type WindowMode = "solo" | "pvp" | null;

/**
 * Assemble the five-verb `CabinetController` from a game's own seam. `goManual` hands THIS seat to
 * the human — a flag flip (ttt/battleship `setAuto(false)`, bomb-it/cross a fresh-read guarded
 * `toggleAuto`) OR a window switch (poker `setMode("bot")`); the assembler stays agnostic to which.
 * Take-over runs `goManual` then unfreezes a hover-pause. `goManual` must be IDEMPOTENT so a double
 * take-over is a no-op (no `auto`/`toggleAuto` contract here — that over-fits the toggle games).
 * Settlement stays self-play on-chain — take-over is cosmetic (ADR-0013).
 */
export function soloCabinetController(args: {
  offerable: boolean;
  pause(): void;
  resume(): void;
  goManual(): void;
  goHome(): void;
}): CabinetController {
  return {
    active: args.offerable,
    pause: args.pause,
    resume: args.resume,
    takeOver: () => {
      args.goManual();
      args.resume();
    },
    returnHome: args.goHome,
  };
}

/**
 * The SOLE cabinet adoption primitive: memoize a controller and register it with the enclosing
 * `<GameCabinet>` (Desktop wraps every window). Every self-play game (ttt, battleship, bomb-it,
 * chicken-cross, poker) calls this with the same shape; only the four expressions differ, and
 * those differences are irreducibly per-game (the offerable predicate and the four verbs).
 *
 * Call once near the top of the window component, before any early return — it is a hook. Pass
 * stable verbs (useCallback) and an inline boolean `offerable`; the controller rebuilds only when
 * one of them changes, so it does not re-register every render.
 */
export function useSoloCabinet(args: {
  offerable: boolean;
  pause(): void;
  resume(): void;
  goManual(): void;
  goHome(): void;
}): void {
  const { offerable, pause, resume, goManual, goHome } = args;
  const controller = useMemo<CabinetController>(
    () => soloCabinetController({ offerable, pause, resume, goManual, goHome }),
    [offerable, pause, resume, goManual, goHome],
  );
  useRegisterCabinet(controller);
}
