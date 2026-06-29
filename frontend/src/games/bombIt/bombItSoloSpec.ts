/**
 * Bomb It as a worker SELF-PLAY spec (the solo-lane sibling of `bombItSpec.ts`, parallel to the
 * legacy `useBombItSession`'s `createSoloSessionHook` declaration). Reuses bomb-it's existing PURE
 * multi-game logic from `session-core.ts` (deriveMultiView / sessionResult / stepMultiGame /
 * kickoffNextGame) and the canonical kit bots — no game rules are reimplemented here. The generic
 * `SoloEngine` owns the rest: the one-signature open+fund of both ephemeral seats, the per-duel
 * `OffchainTunnel.selfPlay` loop, the autopilot/manual cadence, multi-duel rematch, and the
 * cooperative settle.
 */
import { defineSoloGame } from "@/engine/specs/defineGame";
import type { SoloGameSpec } from "@/engine/engineApi";
import {
  MultiGameBombItProtocol,
  type MultiGameBombItState,
  type MultiGameBombItMove,
} from "sui-tunnel-ts/protocol/multiGameBombIt";
import {
  BOMB_IT_MIN_STAKE,
  type BombItMove,
  type BombItAction,
} from "sui-tunnel-ts/protocol/bombIt";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { createBombItKit } from "@/agent/games/bombIt/kit";
import type { GameBot } from "@/agent/gameKit";
import {
  deriveMultiView,
  kickoffNextGame,
  sessionResult,
  stepMultiGame,
  SOLO_STEP_MS,
  type BombItView,
  type BombItResult,
} from "./session-core";

/** Per-seat kit bots threaded into `stepWith`; opaque to the engine (same shape the legacy hook uses). */
type BombBots = Record<
  Party,
  GameBot<MultiGameBombItState, MultiGameBombItMove>
>;

// Annotated as the interface (not the object literal) so `defineSoloGame`'s `S extends AnySoloSpec`
// constraint is checked against method signatures (bivariant) rather than the literal's arrow-property
// signatures (contravariant), which would reject the narrowed `Bots`/`Proto` generics.
const bombItSolo: SoloGameSpec<
  MultiGameBombItState,
  BombItMove,
  BombItAction,
  BombItView,
  BombItResult,
  BombBots,
  MultiGameBombItProtocol
> = {
  game: "bomb-it",
  stake: BOMB_IT_MIN_STAKE, // per-DUEL stake (the small swap); the engine funds the large per-seat bank
  rematchMs: 700,
  // Bomb It is a REACTION game: manual play co-signs one tick per SOLO_STEP_MS so the fuse stays
  // legible; autopilot still batches (the ~500 TPS throughput showcase).
  manualStepMs: SOLO_STEP_MS,
  makeProtocol: (tunnelId, stakePerGame) =>
    new MultiGameBombItProtocol(tunnelId, stakePerGame),
  makeBots: (stakePerGame) => {
    const kit = createBombItKit(stakePerGame);
    return {
      A: kit.createBot("A", { rngForSeat: () => Math.random }),
      B: kit.createBot("B", { rngForSeat: () => Math.random }),
    };
  },
  deriveView: deriveMultiView,
  sessionResult,
  // The take-over seat is always seat A; its queued action defaults to "stay" (a legal no-op move).
  stepWith: (protocol, tunnel, bots, take) =>
    stepMultiGame(
      protocol,
      tunnel,
      bots,
      take ? { seat: "A", getAction: () => take() ?? "stay" } : null,
    ),
  kickoffNextGame,
};

export const bombItSoloSpec = defineSoloGame(bombItSolo);
