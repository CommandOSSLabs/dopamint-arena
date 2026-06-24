import { useMemo } from "react";
import type { CabinetController } from "./CabinetController";
import { useRegisterCabinet } from "./CabinetContext";

/** A window's top-level mode; solo is the only cabinet-offerable one. */
export type WindowMode = "solo" | "pvp" | null;

/** The slice of a solo session the cabinet drives. Both game sessions satisfy it structurally. */
export interface SoloCabinetSession {
  status: string;
  auto: boolean;
  pause(): void;
  resume(): void;
  toggleAuto(): void;
}

/**
 * Take-over is offerable only while the window shows solo AND the self-play loop
 * is actually running on auto — never in the lobby, pvp, funding/settling, or
 * after a take-over (auto off). Mirrors ttt's `scene === "game" && g.auto`.
 */
export function isSoloOfferable(
  mode: WindowMode,
  status: string,
  auto: boolean,
): boolean {
  return mode === "solo" && status === "playing" && auto;
}

/**
 * Build the five-verb controller. `takeOver` flips the loop to the human seat —
 * only when currently auto, so a stray call can't re-enable auto — then unfreezes
 * a hover-pause. Settlement stays self-play on-chain; take-over is cosmetic
 * (ADR-0013).
 */
export function soloCabinetController(args: {
  offerable: boolean;
  auto: boolean;
  pause(): void;
  resume(): void;
  toggleAuto(): void;
  goHome(): void;
}): CabinetController {
  return {
    active: args.offerable,
    pause: args.pause,
    resume: args.resume,
    takeOver: () => {
      if (args.auto) args.toggleAuto();
      args.resume();
    },
    returnHome: args.goHome,
  };
}

/**
 * Register a game window's solo session with the enclosing `<GameCabinet>`
 * (Desktop wraps every window). Call once near the top of the window component,
 * before any early return — it is a hook. `goHome` MUST be stable (useCallback in
 * the caller) so the controller doesn't re-register every render.
 */
export function useSoloCabinet(
  session: SoloCabinetSession,
  mode: WindowMode,
  goHome: () => void,
): void {
  const { status, auto, pause, resume, toggleAuto } = session;
  const offerable = isSoloOfferable(mode, status, auto);
  const controller = useMemo<CabinetController>(
    () =>
      soloCabinetController({
        offerable,
        auto,
        pause,
        resume,
        toggleAuto,
        goHome,
      }),
    [offerable, auto, pause, resume, toggleAuto, goHome],
  );
  useRegisterCabinet(controller);
}
