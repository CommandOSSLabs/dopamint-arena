/**
 * Tracks the most-recently-focused game window per game id so the phone — which
 * shows one game at a time — can resume the EXACT desktop window you were last
 * playing (a `gameId#uuid` duplicate included) when the layout reflows across the
 * `lg` breakpoint or the tab is reopened. Decision: "continue the window you just
 * played" (over collapsing to one canonical session).
 *
 * State lives off-component (a module store, mirrored to localStorage) for the same
 * reason game sessions do: it must outlive the Desktop/Mobile remount on resize.
 */

const KEY = "dopamint.activeWindows.v1";

/** The game id embedded in a window id (`blackjack#ab12` → `blackjack`, `blackjack` → `blackjack`). */
const gameOf = (windowId: string) => windowId.split("#")[0];

type Persisted = {
  /** gameId → the windowId of its last-focused instance. */
  byGame: Record<string, string>;
  /** The game focused most recently of all — what the phone auto-resumes. */
  last: string | null;
};

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Persisted;
  } catch {
    // ignore — fall through to empty
  }
  return { byGame: {}, last: null };
}

let state = load();

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // ignore — persistence is best-effort
  }
}

/** Record `windowId` as the live instance for its game, and the most-recent overall. */
export function markWindowActive(windowId: string): void {
  const game = gameOf(windowId);
  if (state.byGame[game] === windowId && state.last === game) return;
  state = { byGame: { ...state.byGame, [game]: windowId }, last: game };
  save();
}

/** The windowId the phone should mount for `gameId`: its last-active instance, else the bare id. */
export function resolveWindowId(gameId: string): string {
  return state.byGame[gameId] ?? gameId;
}

/** The game focused most recently anywhere, or null — used to auto-resume on the phone. */
export function lastActiveGame(): string | null {
  return state.last;
}

/** Drop a window when it's truly closed so the phone never resumes a dead instance. */
export function forgetWindow(windowId: string): void {
  const game = gameOf(windowId);
  if (state.byGame[game] !== windowId && state.last !== game) return;
  const byGame = { ...state.byGame };
  if (byGame[game] === windowId) delete byGame[game];
  state = { byGame, last: state.last === game ? null : state.last };
  save();
}
