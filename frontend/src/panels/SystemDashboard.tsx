import type { ReactNode } from "react";

import {
  Panel,
  PanelAction,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "@/components/ui/panel";
import { RadialGauge } from "@/components/ui/radial-gauge";
import { Segbar } from "@/components/ui/segbar";
import { useBackendStats } from "@/backend/useBackendStats";
import type { TelemetrySnapshot } from "./types";

// Ceiling the bots segbar fills toward (matches the live source's bot range).
const BOT_CAPACITY = 24;

// Display labels for the backend's per-game `perGame` keys (the `game` id each
// session registers under). Unknown keys fall back to the raw id.
const GAME_LABEL: Record<string, string> = {
  tictactoe: "Tic-Tac-Toe",
  "tic-tac-toe": "Tic-Tac-Toe",
  blackjack: "Blackjack",
  "quantum-poker": "Quantum Poker",
  battleship: "Battleship",
  "bomb-it": "Bomb It",
  "chicken-cross": "Chicken Cross",
  "pixel-paint": "Pixel Wall",
};

// The game whose TPS we highlight — Pixel Wall, the high-throughput paint game.
const HIGHLIGHT_GAME = "pixel-paint";

/** Collapse a backend perGame key to its base game id: clients register sessions
 *  under noisy keys ("blackjack-0-1782…", "chicken-cross:DRUF", "quantum_poker"),
 *  so we strip the session suffix and normalize separators to aggregate per game. */
function baseGameId(key: string): string {
  let k = key.toLowerCase().replace(/_/g, "-");
  k = k.split(":")[0]; // "chicken-cross:DRUF" -> "chicken-cross"
  k = k.replace(/-0-\d+$/, ""); // "blackjack-0-1782…" -> "blackjack"
  k = k.replace(/-\d+$/, ""); // any trailing "-<digits>"
  return k;
}

const titleCase = (s: string) =>
  s
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/** Pulsing "LIVE" indicator shown in the panel header. */
function LiveBadge() {
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-success">
      <span className="size-1.5 animate-pulse rounded-full bg-success" />
      LIVE
    </span>
  );
}

/** Muted indicator shown while the SSE feed is connecting, before the first frame arrives. */
function ConnectingBadge() {
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
      <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
      Connecting
    </span>
  );
}

/** One labelled mono metric, optionally with a mini-visual beneath it. */
function Stat({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="wal-mono truncate text-sm font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {children}
    </div>
  );
}

/**
 * Key telemetry stats sourced from the backend SSE feed (GET /v1/stats/live): the real global
 * aggregates summed across every client. While the feed is connecting the values render dashed
 * (no fake data); only a genuinely-offline backend falls back to this client's local demo
 * telemetry as a radial success gauge + segmented bots bar (patterns from nullframe's
 * Render/Battery cards).
 */
export function SystemDashboard({
  snapshot,
  className,
}: {
  snapshot: TelemetrySnapshot;
  className?: string;
}) {
  const { snapshot: backend, status } = useBackendStats();

  if (status !== "offline") {
    const fmt = (n: number | undefined) =>
      backend && n !== undefined ? Math.round(n).toLocaleString("en-US") : "—";
    const items = [
      { label: "Network TPS", value: fmt(backend?.tps) },
      { label: "Total Actions", value: fmt(backend?.totalActions) },
      { label: "Active Tunnels", value: fmt(backend?.activeTunnels) },
      { label: "Settled Tunnels", value: fmt(backend?.settledTunnels) },
    ];
    // Per-game TPS, aggregated by base game then busiest first — so a single
    // game's contribution (e.g. Pixel Wall, summed across its sessions) is
    // readable apart from the network-wide aggregate above.
    const byGame = new Map<string, number>();
    for (const [key, g] of Object.entries(backend?.perGame ?? {})) {
      const base = baseGameId(key);
      byGame.set(base, (byGame.get(base) ?? 0) + (g.tps ?? 0));
    }
    const perGame = [...byGame.entries()]
      .map(([id, tps]) => ({ id, label: GAME_LABEL[id] ?? titleCase(id), tps }))
      .sort((a, b) => b.tps - a.tps);
    return (
      <Panel className={className}>
        <PanelHeader>
          <PanelTitle>Network{status === "live" ? " (live)" : ""}</PanelTitle>
          <PanelAction>
            {status === "live" ? <LiveBadge /> : <ConnectingBadge />}
          </PanelAction>
        </PanelHeader>
        <PanelContent className="p-3">
          <div className="grid grid-cols-2 gap-3">
            {items.map((it) => (
              <Stat key={it.label} label={it.label} value={it.value} />
            ))}
          </div>
          {perGame.length > 0 && (
            <div className="mt-3 border-t border-border/40 pt-2.5">
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                TPS by game
              </div>
              <div className="grid gap-1">
                {perGame.map((g) => (
                  <div
                    key={g.id}
                    className={`flex items-center justify-between text-xs ${
                      g.id === HIGHLIGHT_GAME
                        ? "font-semibold text-[#4DA2FF]"
                        : "text-foreground"
                    }`}
                  >
                    <span className="truncate">{g.label}</span>
                    <span className="wal-mono tabular-nums">
                      {Math.round(g.tps).toLocaleString("en-US")}
                      <span className="ml-1 text-muted-foreground">tx/s</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </PanelContent>
      </Panel>
    );
  }

  const bots = snapshot.botsRunning;
  const success = snapshot.successRate;
  // Lit segments of the 10-cell bar; floored at 1 so it never reads empty.
  const botsOn = Math.max(
    1,
    Math.round((Math.min(bots, BOT_CAPACITY) / BOT_CAPACITY) * 10),
  );

  return (
    <Panel className={className}>
      <PanelHeader>
        <PanelTitle>System Dashboard</PanelTitle>
        <PanelAction>
          <LiveBadge />
        </PanelAction>
      </PanelHeader>
      <PanelContent className="flex items-center gap-4 p-3">
        <div className="flex flex-col items-center gap-1">
          <RadialGauge
            value={success / 100}
            display={`${success.toFixed(1)}%`}
          />
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Success
          </span>
        </div>
        <div className="grid flex-1 gap-2.5">
          <Stat label="Bots Running" value={String(bots)}>
            <Segbar total={10} on={botsOn} tone="success" className="mt-1.5" />
          </Stat>
          <Stat
            label="Total Balance"
            value={`$${snapshot.totalBalance.toLocaleString("en-US", {
              minimumFractionDigits: 2,
            })}`}
          />
        </div>
      </PanelContent>
    </Panel>
  );
}
