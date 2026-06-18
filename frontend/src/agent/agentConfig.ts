// Agent mode is URL-driven: bare ?agent turns the real app into a self-driving agent that
// rotates ALL tunnel games to maximize concurrent tunnels. No per-game selection.
//   ?agent              enable
//   ?key=suiprivkey1…   the agent's funded wallet secret (Bech32, what getSecretKey() emits)
//   ?m=20               concurrent tunnel slots per agent (default 1 for the P1 proof)
export interface GameSpec {
  /** relay queue id — MUST equal the id the human UI queues, so humans share the queue. */
  id: string;
  /** createBehaviorProtocol() key (sui-tunnel-ts/agents/behaviors). */
  behavior: "tictactoe" | "blackjack" | "payment" | "chat" | "poker";
  /** per-seat locked stake (MIST). */
  stake: bigint;
}

// The full rotation set; the engine cycles this to keep every queue populated.
export const AGENT_GAMES: GameSpec[] = [
  { id: "tictactoe", behavior: "tictactoe", stake: 500n },
  { id: "blackjack", behavior: "blackjack", stake: 500n },
  { id: "payments", behavior: "payment", stake: 500n },
  { id: "chat", behavior: "chat", stake: 500n },
  { id: "quantumpoker", behavior: "poker", stake: 500n },
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
