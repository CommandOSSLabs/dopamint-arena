// Per-game "auto" (bot-plays-your-seat) default, kept in memory for the page session.
//
// Auto is ON for the FIRST match a player starts (the attract flow — they watch a bot play),
// then tracks their last explicit toggle so the next game keeps their choice: turn it off and new
// games stay off. Never persisted — a fresh page load starts back at auto-ON-first-time.
//
// Read at each match's fresh-start point (`defaultAuto`); written only when the player toggles
// (`rememberAuto`). One bool per game key (the matchmaking/resume label, e.g. "bomb-it", "caro").
const autoByGame = new Map<string, boolean>();

/** The auto value a new match should start with: the player's last toggle, or ON the first time. */
export function defaultAuto(game: string): boolean {
  return autoByGame.get(game) ?? true;
}

/** Record the player's explicit auto choice so the next game this session keeps it. */
export function rememberAuto(game: string, on: boolean): void {
  autoByGame.set(game, on);
}
