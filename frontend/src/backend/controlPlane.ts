// Control-plane client for the tunnel-manager backend (ADR-0002). The backend is the
// stats/settlement spine and is NEVER in the per-move loop — so register/heartbeat
// failures are logged by callers and must not block local play.
//
// Wire contract (ADR-0002): base path /v1, JSON, camelCase. u64 values (nonce,
// balances, timestamp) travel as decimal strings; 32-byte values as 0x-hex.

export interface TunnelRef {
  tunnelId: string;
  partyA: string;
  partyB: string;
}

export interface RegisterSessionResult {
  sessionId: string;
  statsToken: string;
}

/** Coarse, aggregated throughput report — one call per ~window, never per move. */
export interface Heartbeat {
  tunnelId: string;
  nonce: string;
  actionsDelta: number;
  windowMs: number;
}

/** Per-game slice of the live aggregate feed. Field names match the backend's serde. */
export interface GameStats {
  tps: number;
  tunnels: number;
  total_actions?: number;
}

/** One server-sent aggregate snapshot from GET /v1/stats/live. */
export interface StatsSnapshot {
  tps: number;
  totalActions: number;
  activeTunnels: number;
  settledTunnels: number;
  perGame: Record<string, GameStats>;
}

export interface ControlPlaneClient {
  registerSession(input: {
    userAddress: string;
    game: string;
    tunnels: TunnelRef[];
  }): Promise<RegisterSessionResult>;
  sendHeartbeat(
    sessionId: string,
    statsToken: string,
    heartbeat: Heartbeat,
  ): Promise<void>;
  /** Subscribe to the live aggregate SSE feed; returns an unsubscribe fn. */
  openStatsStream(onSnapshot: (snapshot: StatsSnapshot) => void): () => void;
}

class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

async function failIfNotOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  // The backend returns { error: { code, message } } on failure (ADR-0002).
  let detail = res.statusText;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) detail = body.error.message;
  } catch {
    // non-JSON body; keep statusText
  }
  throw new ControlPlaneError(
    res.status,
    `${what} failed: ${res.status} ${detail}`,
  );
}

export function createControlPlaneClient(baseUrl: string): ControlPlaneClient {
  const root = baseUrl.replace(/\/+$/, "");

  return {
    async registerSession(input) {
      const res = await fetch(`${root}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      await failIfNotOk(res, "registerSession");
      return (await res.json()) as RegisterSessionResult;
    },

    async sendHeartbeat(sessionId, statsToken, heartbeat) {
      const res = await fetch(`${root}/v1/sessions/${sessionId}/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${statsToken}`,
        },
        body: JSON.stringify(heartbeat),
      });
      await failIfNotOk(res, "sendHeartbeat");
    },

    openStatsStream(onSnapshot) {
      const source = new EventSource(`${root}/v1/stats/live`);
      source.onmessage = (ev) => {
        try {
          onSnapshot(JSON.parse(ev.data) as StatsSnapshot);
        } catch {
          // ignore malformed frames; the feed is best-effort
        }
      };
      return () => source.close();
    },
  };
}

/**
 * Resolve the backend base URL from VITE_BACKEND_URL. Set it to the ALB for the usual
 * cross-origin case — the backend serves CORS headers (main.rs). Leave it empty ONLY for
 * a same-origin deploy (frontend behind the same host as the backend); there is no dev
 * proxy fallback anymore, so an empty value in dev resolves to the dev server itself.
 */
export function resolveBackendUrl(): string {
  return import.meta.env.VITE_BACKEND_URL ?? "";
}

let cachedClient: ControlPlaneClient | undefined;

/** Browser singleton shared across game modules. Per-call failures are caught by callers —
 *  the backend is the stats/settlement spine, never the per-move loop, so it can't block play. */
export function getControlPlaneClient(): ControlPlaneClient {
  if (!cachedClient)
    cachedClient = createControlPlaneClient(resolveBackendUrl());
  return cachedClient;
}
