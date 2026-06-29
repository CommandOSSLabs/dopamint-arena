// frontend/src/games/battleship/battleshipSelfPlay.ts
// Pure, React-free, on-chain-free engine for Battleship vs-bot. Mirrors
// quantumPoker/pokerSelfPlay.ts: wraps the agent kit's BattleshipBot so the bot
// move logic has ONE source. Drives the MULTI-game tunnel by planning against the
// inner single-game state. PvP is a separate bespoke driver (engine/pvpDriver.ts).
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type {
  BattleshipMove,
  BattleshipState,
} from "sui-tunnel-ts/protocol/battleship";
import { createBattleshipKit } from "@/agent/games/battleship/kit";
import type { BotContext, GameBot } from "@/agent/gameKit";
import type { BotDifficulty } from "./engine/bot";
import type { FleetSecret } from "./engine/selfPlay";
import type {
  MultiGameBattleshipMove,
  MultiGameBattleshipState,
} from "./protocol/multiGameBattleship";

export type BattleshipTunnel = OffchainTunnel<
  MultiGameBattleshipState,
  MultiGameBattleshipMove
>;
/** The kit bot operates on a single inner game. */
export type BattleshipSeatBot = GameBot<BattleshipState, BattleshipMove>;

/** Real-time RNG context for kit bots (live play, not a seeded replay). */
export const LIVE_BOT_CONTEXT: BotContext = { rngForSeat: () => Math.random };

/** One kit bot for a seat over a fixed fleet. `pipeline` true = miss-answers carry
 *  the return shot (bench TPS); false = bare (a human fires its own shot). */
export function makeSeatBot(
  seat: Party,
  stake: bigint,
  difficulty: BotDifficulty,
  secret: FleetSecret,
  pipeline: boolean,
  ctx: BotContext,
): BattleshipSeatBot {
  return createBattleshipKit(stake, { difficulty, secret, pipeline }).createBot(
    seat,
    ctx,
  );
}

/** True when it is the human seat's turn to fire — the one human-driven move. */
export function isHumanShootTurn(
  inner: BattleshipState,
  humanSeat: Party,
): boolean {
  return (
    inner.phase === "playing" && inner.turn === humanSeat && !inner.pendingShot
  );
}

/** Apply exactly one auto move for whichever seat owes one in the RUNNING game.
 *  Null = the inner game is over (the multi-game rematch is the caller's job) or
 *  no seat has a move. */
export function stepBattleshipAuto(
  tunnel: BattleshipTunnel,
  botA: BattleshipSeatBot,
  botB: BattleshipSeatBot,
): { by: Party; move: BattleshipMove } | null {
  const inner = tunnel.state.inner;
  if (inner.phase === "over") return null;
  const order: Party[] = ["A", "B"];
  for (const by of order) {
    const bot = by === "A" ? botA : botB;
    const move = bot.plan(inner);
    if (!move) continue;
    tunnel.step(move, by);
    bot.confirm(inner, move);
    return { by, move };
  }
  return null;
}

export type BattleshipHumanStep =
  | { kind: "applied"; by: Party; move: BattleshipMove }
  | { kind: "await-human" }
  | { kind: "idle" };

/** Like stepBattleshipAuto, but yields on the human seat's SHOT turn. The human
 *  seat's mechanical moves (commit / answer / reveal_board) still auto-run via its
 *  kit bot — only the shot waits for the human. */
export function stepBattleshipWithHuman(
  tunnel: BattleshipTunnel,
  botA: BattleshipSeatBot,
  botB: BattleshipSeatBot,
  humanSeat: Party,
): BattleshipHumanStep {
  const inner = tunnel.state.inner;
  if (inner.phase === "over") return { kind: "idle" };
  if (isHumanShootTurn(inner, humanSeat)) return { kind: "await-human" };
  const r = stepBattleshipAuto(tunnel, botA, botB);
  return r ? { kind: "applied", by: r.by, move: r.move } : { kind: "idle" };
}

/** Apply the human's shot for `humanSeat` and advance its kit bot's memory. */
export function applyHumanShot(
  tunnel: BattleshipTunnel,
  humanBot: BattleshipSeatBot,
  humanSeat: Party,
  cell: number,
): void {
  const inner = tunnel.state.inner;
  const move: BattleshipMove = { kind: "shoot", cell };
  tunnel.step(move, humanSeat);
  humanBot.confirm(inner, move);
}

/** Drive both seats through ONE game to inner `over`. Returns moves applied.
 *  (Multi-game rematch is not handled here — the inner terminal stops it.) */
export function runBattleshipSelfPlayToEnd(
  tunnel: BattleshipTunnel,
  botA: BattleshipSeatBot,
  botB: BattleshipSeatBot,
  maxSteps: number,
): number {
  let steps = 0;
  while (steps < maxSteps && tunnel.state.inner.phase !== "over") {
    const r = stepBattleshipAuto(tunnel, botA, botB);
    if (!r) break;
    steps += 1;
  }
  return steps;
}
