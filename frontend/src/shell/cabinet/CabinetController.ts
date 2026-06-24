/**
 * The contract a game's App registers (via `useRegisterCabinet`) so the shared
 * `GameCabinet` shell can offer the universal "watch → take over" arcade UX.
 *
 * The shell owns the universal parts — hover detection, the take-over overlay,
 * and the attract→inviting→live state machine. The game owns HOW each verb maps
 * onto its own engine; the shell never sees the internals.
 *
 * Canonical adoption for a new game:
 *   1. Wrap the game's window root in `<GameCabinet>`.
 *   2. Inside, call `useRegisterCabinet(controller)` with the verbs below.
 *   3. Implement the verbs in the game's own idiom — a turn-loop freeze, a
 *      physics-loop freeze, a hand-boundary swap, etc. The verbs should be
 *      stable (useCallback); rebuild the controller only when `active` flips.
 */
export interface CabinetController {
  /**
   * True only while the game is auto-playing and a take-over is offerable
   * (the "attract" state). When false the shell stays inert — no hover-pause,
   * no overlay — so login/setup/manual scenes are untouched.
   */
  active: boolean;
  /** Freeze the auto-play in place (hover). Best-effort; no-op when not mid-play. */
  pause(): void;
  /** Resume after a hover that didn't lead to a take-over. */
  resume(): void;
  /** Hand the seat to the human (ttt: flip the engine to manual play). */
  takeOver(): void;
  /** Leave the live game — send the game back to its own home screen. */
  returnHome(): void;
}
