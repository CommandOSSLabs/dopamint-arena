// frontend/src/games/quantumPoker/pokerSelfPlay.ts
// Pure, React-free, on-chain-free engine for poker self-play. Shared by the Auto
// loop and the Play-vs-Bot router, and unit-tested off-chain.
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  type PokerMove,
  type PokerPhase,
  type PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import {
  DEFAULT_QUANTUM_POKER_BOT_PROFILES,
  type QuantumPokerBotProfile,
} from "sui-tunnel-ts/protocol/quantumPokerPersona";
import { createQuantumPokerKit } from "@/agent/games/quantumPoker/kit";
import type { BotContext, GameBot } from "@/agent/gameKit";

export type PokerTunnel = OffchainTunnel<PokerState, PokerMove>;
export type PokerSeatBot = GameBot<PokerState, PokerMove>;

/** Real-time RNG context for kit bots (live play, not a seeded replay). */
export const LIVE_BOT_CONTEXT: BotContext = { rngForSeat: () => Math.random };

const BETTING_PHASES: ReadonlySet<PokerPhase> = new Set([
  "preflop_bet",
  "flop_bet",
  "turn_bet",
  "river_bet",
]);

export function randomPokerPersona(rng: () => number): QuantumPokerBotProfile {
  const list = DEFAULT_QUANTUM_POKER_BOT_PROFILES;
  return list[Math.floor(rng() * list.length)];
}

/** One canonical kit bot for a seat with a chosen persona. */
export function makeSeatBot(
  seat: Party,
  stake: bigint,
  handCap: bigint,
  profile: QuantumPokerBotProfile,
  ctx: BotContext,
): PokerSeatBot {
  return createQuantumPokerKit(stake, handCap, { profile }).createBot(
    seat,
    ctx,
  ) as PokerSeatBot;
}

export function isHumanBettingTurn(
  state: PokerState,
  humanSeat: Party,
): boolean {
  return BETTING_PHASES.has(state.phase) && state.toAct === humanSeat;
}

export interface PokerLegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  /** MIST needed to call (must equal toCall; no partial calls allowed by the protocol). */
  callAmount: bigint;
  /** Minimum legal `bet` move amount (raise increment); 0n if no raise is possible. */
  minBet: bigint;
  /** Maximum `bet` amount = remaining effective stack. */
  maxBet: bigint;
}

/** Legal betting options for `seat`, computed from public state (mirrors the
 *  protocol's bet/call/check rules: a bet must raise above the opponent's street
 *  bet, and nothing may exceed the effective (shorter) stack). */
export function legalPokerActions(
  s: PokerState,
  seat: Party,
): PokerLegalActions {
  const myStreet = seat === "A" ? s.streetBetA : s.streetBetB;
  const oppStreet = seat === "A" ? s.streetBetB : s.streetBetA;
  const myTotal = seat === "A" ? s.totalBetA : s.totalBetB;
  const effStack = s.balanceA < s.balanceB ? s.balanceA : s.balanceB;
  const available = effStack - myTotal > 0n ? effStack - myTotal : 0n;
  const toCall = oppStreet > myStreet ? oppStreet - myStreet : 0n;
  return {
    canFold: true,
    canCheck: toCall === 0n,
    canCall: toCall > 0n && available >= toCall,
    callAmount: toCall,
    minBet: available > toCall ? toCall + 1n : 0n,
    maxBet: available,
  };
}

/** Apply exactly one auto move for whichever seat has one. Null = terminal/idle. */
export function stepPokerAuto(
  tunnel: PokerTunnel,
  botA: PokerSeatBot,
  botB: PokerSeatBot,
  timestamp: bigint,
): { by: Party; move: PokerMove } | null {
  const s = tunnel.state;
  if (s.phase === "done") return null;
  const order: Party[] = ["A", "B"];
  for (const by of order) {
    const bot = by === "A" ? botA : botB;
    const move = bot.plan(s);
    if (!move) continue;
    tunnel.step(move, by, { timestamp });
    bot.confirm(s, move);
    return { by, move };
  }
  return null;
}

/** Drive both seats to `phase==="done"`. Returns the number of moves applied. */
export function runPokerSelfPlayToEnd(
  tunnel: PokerTunnel,
  botA: PokerSeatBot,
  botB: PokerSeatBot,
  maxSteps: number,
): number {
  let steps = 0;
  let ts = 1n;
  while (steps < maxSteps && tunnel.state.phase !== "done") {
    const r = stepPokerAuto(tunnel, botA, botB, ts++);
    if (!r) break;
    steps += 1;
  }
  return steps;
}

export type PokerHumanStep =
  | { kind: "applied"; by: Party; move: PokerMove }
  | { kind: "await-human" }
  | { kind: "idle" };

/** Like stepPokerAuto, but yields control on the human seat's BETTING turn.
 *  The human seat's mechanical moves (commit/reveal/next_hand) still auto-run via
 *  its kit bot — only bet/check/call/fold wait for the human. */
export function stepPokerWithHuman(
  tunnel: PokerTunnel,
  botA: PokerSeatBot,
  botB: PokerSeatBot,
  humanSeat: Party,
  timestamp: bigint,
): PokerHumanStep {
  const s = tunnel.state;
  if (s.phase === "done") return { kind: "idle" };
  if (isHumanBettingTurn(s, humanSeat)) return { kind: "await-human" };
  const r = stepPokerAuto(tunnel, botA, botB, timestamp);
  return r ? { kind: "applied", by: r.by, move: r.move } : { kind: "idle" };
}

/** Apply a human-chosen move for `humanSeat`; advances its kit bot's memory. */
export function applyHumanMove(
  tunnel: PokerTunnel,
  humanBot: PokerSeatBot,
  humanSeat: Party,
  move: PokerMove,
  timestamp: bigint,
): void {
  const s = tunnel.state;
  tunnel.step(move, humanSeat, { timestamp });
  humanBot.confirm(s, move);
}
