# Battleship bot

The bot's only decision is **which cell to fire at next** — committing and
revealing (with a Merkle proof) are forced by the protocol. That decision lives
in `bot.ts`, isolated from the move driver (`selfPlay.ts`) so it can be tuned
and tested on its own.

`pickShot(state, shooter, rng, config)` reads the shots resolved so far and
returns an unfired cell. It never repeats a shot. `rng` (`() => number` in
[0,1)) only breaks ties, so play is reproducible under a seed.

## Hunt and target

Every turn is one of two modes:

- **Hunt** — no live hits to chase, so search for a fresh ship.
- **Target** — a hit isn't sunk yet, so finish that ship.

## Difficulty

Difficulty swaps how each mode behaves (`BOT_CONFIGS`, default `normal`):

| Tier   | Hunt                | Target                                  |
| ------ | ------------------- | --------------------------------------- |
| Easy   | random cell         | fire the hit's open neighbours          |
| Normal | parity (see below)  | follow the line — fire the run's ends   |
| Hard   | probability density | probability density (same pass)         |

- **Parity hunt** — fire only one colour of the board's checkerboard. The
  smallest ship is 2 cells, so it always covers a cell of each colour: searching
  one colour never misses a ship yet roughly halves the blind shots.
- **Probability density** — score every open cell by how many placements of the
  still-unsunk fleet could legally cover it, then fire the maximum. Placements
  are blocked by misses and by sunk ships; a placement covering a live hit is
  weighted far higher, so the bot pours fire into finishing a wounded ship and
  extends along the line on its own. Deterministic — it plays, it doesn't guess.

**Sunk detection** uses the rule that ships never touch (not even diagonally): a
4-connected run of hits is exactly one ship, so a run blocked at both ends is
provably sunk. Sunk ships drop out of the search and their surrounding ring is
marked unplaceable, so the bot stops wasting shots around dead ships.

## Tests

```bash
pnpm test   # bot.test.ts (node:test via tsx)
```
