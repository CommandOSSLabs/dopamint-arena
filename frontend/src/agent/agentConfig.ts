// Agent mode is URL-driven: bare ?agent turns the real app into a self-driving agent that
// rotates ALL tunnel games to maximize concurrent tunnels. No per-game selection.
//   ?agent              enable
//   ?key=suiprivkey1…   the agent's funded wallet secret (Bech32, what getSecretKey() emits)
//   ?m=20               concurrent tunnel slots per agent (default 1 for the P1 proof)
export interface GameSpec {
  /** relay queue id — MUST equal the id the human UI queues, so humans share the queue. */
  id: string;
  /** createBehaviorProtocol() key (sui-tunnel-ts/agents/behaviors). */
  behavior:
    | "tictactoe"
    | "blackjack"
    | "payment"
    | "chat"
    | "poker"
    | "pixelpaint";
  /** per-seat locked stake (MIST). */
  stake: bigint;
  /** Turn-free game: no state.turn — the proposer is derived from `placed` parity. */
  turnFree?: boolean;
  /**
   * Commit-reveal game (pixel-duel): each agent locally generates its own secret
   * template + salt, EXCHANGES the 32-byte commit with the peer before the tunnel
   * is built, then builds the protocol with BOTH commits. The engine drives play
   * with the seat bot's `plan` and injects the terminal `reveal` (randomMove
   * structurally cannot produce one). See the duel path in agentEngine.ts.
   */
  commitReveal?: boolean;
}

// The rotation set the engine cycles. Tic-tac-toe (turn-based) and pixel-paint (turn-free,
// free mode) are move-trigger-ready. The others use a phase-based turn model the generic
// move-trigger doesn't yet drive (deferred follow-up), and rotating into them would open
// tunnels that stall and strand stakes. Re-add them once the move-trigger is protocol-driven.
export const AGENT_GAMES: GameSpec[] = [
  { id: "tictactoe", behavior: "tictactoe", stake: 500n },
  { id: "pixel-paint", behavior: "pixelpaint", stake: 500n, turnFree: true },
  // Pixel-duel: turn-free paint war + commit-reveal terminal. The engine's duel
  // path generates each seat's secret template, swaps commits, and injects the
  // reveal; `behavior` is unused (the protocol needs both commits, built inline).
  {
    id: "pixel-duel",
    behavior: "pixelpaint",
    stake: 500n,
    turnFree: true,
    commitReveal: true,
  },
  // { id: "blackjack", behavior: "blackjack", stake: 500n },
  // { id: "payments", behavior: "payment", stake: 500n },
  // { id: "chat", behavior: "chat", stake: 500n },
  // { id: "quantumpoker", behavior: "poker", stake: 500n },
];

export interface AgentConfig {
  enabled: boolean;
  secretKey: string | null; // Bech32 suiprivkey1… for the agent's funded wallet
  concurrency: number; // M: concurrent tunnel slots per agent
}

export function parseAgentConfig(href: string): AgentConfig {
  const p = new URL(href).searchParams;
  return {
    enabled: p.get("agent") !== null,
    secretKey: p.get("key"),
    concurrency: Math.max(1, Number(p.get("m") ?? "1")),
  };
}

/** Round-robin index into AGENT_GAMES; wraps. Lives here (not the engine) so it's testable
 *  without pulling the engine's browser/SDK import graph into a node test. */
export function nextGameIndex(i: number, len: number): number {
  return len <= 1 ? 0 : (i + 1) % len;
}
