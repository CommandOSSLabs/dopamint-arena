# 0012 — Arena attract mode: shared cabinet seam; take-over is a config

- **Status**: Accepted
- **Date**: 2026-06-24

## Context

On connect, the arena floor shows every game window auto-playing itself;
hovering a window freezes it and offers a take-over ("Play vs Bot"). This
hover → pause → offer → take-the-seat behavior is identical for every game, so
re-implementing it per game would duplicate UX and drift. Two questions had to
be resolved the same way for all games: where the auto-play moves come from, and
what "you vs the bot" actually means on-chain.

The [canonical game-bot kit](../superpowers/specs/2026-06-19-canonical-game-bot-kit-design.md)
already gives each game a pure `protocol` + `createBot(seat).plan(state)` as the
single source of auto-play moves (shared with the agent test harness).

## Decision

- **One shared cabinet shell.** `frontend/src/shell/cabinet/GameCabinet` wraps
  every desktop window and owns hover → pause → the take-over overlay and the
  `attract → inviting → live` state machine. A game opts in by publishing a
  `CabinetController` (`active` flag + `pause` / `resume` / `takeOver` /
  `returnHome`). The shell is **inert until a game registers**, so adoption is
  incremental and game-agnostic.
- **Auto-play is just a config.** Auto on → the game's kit bot plays both seats;
  auto off → the human plays that seat through the game's own board UI.
  Take-over flips auto off. The kit is the brain; the shell only adds the
  overlay. "Return to Home" sends the game back to its **own** home screen.
- **Take-over is cosmetic on-chain today.** It reuses the game's in-game manual
  mode, but the running tunnel is `OffchainTunnel.selfPlay` holding both bot
  keys, so settlements stay bot-vs-bot — your clicks are recorded as the bot
  seat's moves. The genuine you-vs-bot (a fresh channel with the human's zkLogin
  address + an ephemeral seat key as party A, gas-sponsored) is **deferred**; the
  machinery (`pvpIdentity`, `pvpOnchain`, sponsor) already exists.
- **Scope: every arena game.** All of them already share the shape this needs — a
  self-play/auto loop plus a path for a human to take a seat: ttt's auto toggle,
  blackjack's hit/stand, battleship's autopilot, quantum poker's watch → Play-vs-Bot
  modes, and bomb-it / chicken-cross's `HumanSeat`. The cabinet standardizes the
  hover → take-over UX over all of them; ttt is the reference, the rest adopt by
  registering a controller (engine mechanics vary — a flag flip vs a mode switch).
- **No shell chrome.** The shell adds no `AUTO` badge and imposes no cadence;
  each game owns its own auto indicator and runs at its native speed.

## Consequences

- **Easier:** any arena game inherits the whole attract/take-over UX by
  (1) driving its auto from its kit, (2) exposing `pause`/`resume` + a manual
  mode, (3) registering a `CabinetController`. No per-game overlay code.
- **Committed to:** the `CabinetController` contract and kit-as-auto-source.
  Genuine two-party settlement remains the on-chain model ([ADR-0006](0006-genuine-two-party-only-drop-self-play.md)).
- **Adopted so far:** tic-tac-toe (reference) and blackjack — each registers a
  `CabinetController` and exposes a hover-pause latch on its bot hook; take-over
  reuses the existing in-game manual mode (ttt's auto flag, blackjack's Hit/Stand).
- **Explicitly not done:** a real you-vs-bot channel at take-over (cosmetic
  today — "you vs bot" is presentational until the ephemeral-channel work lands);
  rolling the controller past ttt/blackjack to the remaining games (each just
  registers one); deduping the per-hook pause/resume machinery into a shared
  primitive (kept as small, stable duplication).
