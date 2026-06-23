// Agent mode is URL-driven: bare ?agent turns the real app into a self-driving agent that
// rotates ALL tunnel games to maximize concurrent tunnels. No per-game selection.
//   ?agent              enable
//   ?key=suiprivkey1…   the agent's funded wallet secret (Bech32, what getSecretKey() emits)
//   ?m=20               concurrent tunnel slots per agent (default 1 for the P1 proof)
//   ?game=quantum-poker restrict rotation to one game id / kit id
import type { GameId } from "./gameKit";

export interface GameSpec {
  /** Canonical bot kit id. */
  kitId: GameId;
  /** Relay queue id — MUST equal the id the human UI queues, so humans share the queue. */
  id: string;
  /** Per-seat locked stake (MIST). If omitted, the kit's default stake is used. */
  stake?: bigint;
}

// The rotation set the engine cycles. The engine is protocol-driven through GAME_KITS, so
// phase-based games no longer need a bespoke move trigger.
export const AGENT_GAMES: GameSpec[] = [
  { id: "tictactoe", kitId: "tictactoe", stake: 500n },
  { id: "blackjack", kitId: "blackjack", stake: 500n },
  { id: "battleship", kitId: "battleship", stake: 500n },
  { id: "quantum-poker", kitId: "quantum-poker", stake: 10_000n },
];

export interface AgentConfig {
  enabled: boolean;
  secretKey: string | null; // Bech32 suiprivkey1… for the agent's funded wallet
  concurrency: number; // M: concurrent tunnel slots per agent
  game: string | null; // optional game queue / kit filter
}

export function parseAgentConfig(href: string): AgentConfig {
  const p = new URL(href).searchParams;
  return {
    enabled: p.get("agent") !== null,
    secretKey: p.get("key"),
    concurrency: Math.max(1, Number(p.get("m") ?? "1")),
    game: p.get("game"),
  };
}

/** Round-robin index into AGENT_GAMES; wraps. Lives here (not the engine) so it's testable
 *  without pulling the engine's browser/SDK import graph into a node test. */
export function nextGameIndex(i: number, len: number): number {
  return len <= 1 ? 0 : (i + 1) % len;
}
