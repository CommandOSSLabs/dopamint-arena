import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  useWorldCanvasOnchain,
  type WorldCanvasPhase,
  type UseWorldCanvasOnchain,
  type AgentSpeed,
  type AgentMode,
} from "../useWorldCanvasOnchain";
import { WorldCanvas } from "./WorldCanvas";
import { PaletteDock } from "./PaletteDock";
import { PlayersActivityPanel, LeaderboardPanel } from "./panels";
import { WC, glass, agentPill, FONT_DISPLAY, FONT_MONO } from "./tokens";

/**
 * The live wall: mounts the tunnel hook (which opens a sponsored 2-party tunnel
 * on mount), renders the chunked canvas, and overlays the HUD — paint stats +
 * live TPS, the on-chain status chip, and the "Agent AI" spawn/stop controls.
 * One human click = one co-signed paint; each spawned agent paints forever.
 */
export function CanvasView() {
  const engine = useWorldCanvasOnchain();
  const [color, setColor] = useState(13); // default to Sui blue (index 13)
  const [brushSize, setBrushSize] = useState(1); // 1×1 brush by default
  const tps = useRollingTps(engine.status.movesCoSigned);

  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden"
      style={{ background: WC.bg, fontFamily: FONT_DISPLAY }}
    >
      <WorldCanvas
        paints={engine.paints}
        revision={engine.revision}
        selectedColor={color}
        brushSize={brushSize}
        disabled={engine.status.phase === "opening"}
        onPaint={engine.submitHumanPaint}
        agents={engine.agents}
        focus={engine.focus}
        humanAddress={engine.humanAddress}
      />

      {/* Stats panel (top-left): pixels co-signed + live TPS + active agents */}
      <div
        className="absolute left-4 top-4 flex flex-col gap-2 rounded-[14px] px-4 py-3"
        style={{ ...glass, color: WC.text, minWidth: 168 }}
      >
        <Stat
          label="Pixels co-signed"
          value={engine.status.movesCoSigned.toLocaleString()}
          tint={WC.accent}
        />
        <Stat label="TPS" value={tps.toFixed(1)} tint={WC.ok} mono />
        <Stat
          label="Active agents"
          value={String(engine.agentCount)}
          tint={WC.seatB}
        />
      </div>

      {/* Status chip (top-right) */}
      <div className="absolute right-4 top-4">
        <StatusChip phase={engine.status.phase} onchain={engine.status.onchain} />
      </div>

      {/* Agent-AI controls (right, below the chip): spawn + Speed + Intelligence +
          View Agent + Stop. Each spawn opens the agent its OWN co-signed tunnel. */}
      <AgentControls engine={engine} />

      {/* Players + Recent Activity and Leaderboard (draggable glass panels) */}
      <PlayersActivityPanel
        painters={engine.painters}
        activity={engine.activity}
        humanAddress={engine.humanAddress}
        agents={engine.agents}
        onFocusAgent={engine.focusOnAgent}
        revision={engine.revision}
      />
      <LeaderboardPanel painters={engine.painters} revision={engine.revision} />

      <PaletteDock
        selected={color}
        onSelect={setColor}
        brushSize={brushSize}
        onBrushSizeChange={setBrushSize}
      />
    </div>
  );
}

/** Derive a live throughput number from the monotonic co-signed paint count via a
 *  short sliding window (sampled every 500 ms over ~3 s) — a coarse TPS dial. */
function useRollingTps(movesCoSigned: number): number {
  const [tps, setTps] = useState(0);
  const samples = useRef<{ t: number; n: number }[]>([]);
  const latest = useRef(movesCoSigned);
  latest.current = movesCoSigned;

  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      const s = samples.current;
      s.push({ t: now, n: latest.current });
      while (s.length > 1 && now - s[0].t > 3000) s.shift();
      const first = s[0];
      const dt = (now - first.t) / 1000;
      setTps(dt > 0 ? Math.max(0, (latest.current - first.n) / dt) : 0);
    }, 500);
    return () => clearInterval(id);
  }, []);

  return tps;
}

function Stat({
  label,
  value,
  tint,
  mono,
}: {
  label: string;
  value: string;
  tint: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className="text-[9.5px] uppercase tracking-[0.16em]"
        style={{ color: WC.muted, fontFamily: FONT_MONO }}
      >
        {label}
      </span>
      <span
        className="text-[19px] font-bold leading-none tabular-nums"
        style={{ color: tint, fontFamily: mono ? FONT_MONO : FONT_DISPLAY }}
      >
        {value}
      </span>
    </div>
  );
}

const CHIP: Record<
  WorldCanvasPhase,
  { label: string; tint: string; pulse: boolean }
> = {
  idle: { label: "Idle", tint: WC.muted, pulse: false },
  opening: { label: "Opening tunnel…", tint: WC.warn, pulse: true },
  open: { label: "On-chain · live", tint: WC.ok, pulse: true },
  demo: { label: "Self-play · demo", tint: WC.warn, pulse: true },
  error: { label: "Error", tint: WC.err, pulse: false },
};

const AGENT_SPEEDS: { value: AgentSpeed; label: string }[] = [
  { value: "slow", label: "Slow" },
  { value: "normal", label: "Normal" },
  { value: "fast", label: "Fast" },
];

const AGENT_MODES: { value: AgentMode; label: string; title: string }[] = [
  { value: "artist", label: "Artist", title: "Draws the flag designs (Vietnam / Japan)" },
  { value: "scatter", label: "Scatter", title: "Sprays random pixels in random colors" },
  { value: "filler", label: "Filler", title: "Floods one solid region growing outward" },
];

/**
 * Agent-AI control card: the spawn button plus the Speed (paint interval) and
 * Intelligence (Artist / Scatter / Filler) selectors, then — once agents exist — a
 * "View Agent" camera-cycle and a Stop. Speed/mode apply to new spawns and live ones.
 */
function AgentControls({ engine }: { engine: UseWorldCanvasOnchain }) {
  return (
    <div
      className="absolute right-4 top-[64px] flex w-[210px] flex-col gap-2.5 rounded-[14px] px-3 py-3"
      style={{ ...glass, color: WC.text }}
    >
      <button
        onClick={engine.spawnAgent}
        className="flex items-center justify-center gap-2 rounded-[12px] px-4 py-2.5 text-sm font-bold"
        style={{
          color: "#06203B",
          background: WC.accent,
          boxShadow: "0 6px 20px rgba(77,162,255,0.45)",
          cursor: "pointer",
        }}
        title="Spawn one bot that paints forever over its OWN co-signed tunnel"
      >
        <span style={{ fontSize: 15 }}>🤖</span> Agent AI
      </button>

      <ControlRow label="Speed">
        {AGENT_SPEEDS.map((s) => (
          <button
            key={s.value}
            onClick={() => engine.setAgentSpeed(s.value)}
            style={{ ...agentPill(engine.agentSpeed === s.value, WC.accent), flex: 1 }}
            title={`Paint speed: ${s.label}`}
          >
            {s.label}
          </button>
        ))}
      </ControlRow>

      <ControlRow label="Intelligence">
        {AGENT_MODES.map((m) => (
          <button
            key={m.value}
            onClick={() => engine.setAgentMode(m.value)}
            style={{ ...agentPill(engine.agentMode === m.value, WC.seatB), flex: 1 }}
            title={m.title}
          >
            {m.label}
          </button>
        ))}
      </ControlRow>

      {engine.agentCount > 0 && (
        <div className="flex gap-2">
          <button
            onClick={engine.viewNextAgent}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-[12px] px-3 py-1.5 text-xs font-bold"
            style={{
              color: WC.text,
              background: WC.accentSoft,
              border: `1px solid ${WC.accent}`,
              cursor: "pointer",
            }}
            title="Cycle the camera to the next active agent"
          >
            📍 View Agent
          </button>
          <button
            onClick={engine.stopAgents}
            className="rounded-[12px] px-3 py-1.5 text-xs font-bold"
            style={{
              color: WC.text,
              background: "rgba(255,90,106,0.16)",
              border: "1px solid rgba(255,90,106,0.4)",
              cursor: "pointer",
            }}
            title="Stop all agents and tear down their tunnels"
          >
            ✕ {engine.agentCount}
          </button>
        </div>
      )}
    </div>
  );
}

/** A labeled row of segmented pills inside the agent control card. */
function ControlRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className="text-[9px] uppercase tracking-[0.18em]"
        style={{ color: WC.muted, fontFamily: FONT_MONO }}
      >
        {label}
      </span>
      <div className="flex gap-1">{children}</div>
    </div>
  );
}

function StatusChip({
  phase,
  onchain,
}: {
  phase: WorldCanvasPhase;
  onchain: boolean;
}) {
  const c = CHIP[phase];
  const label = phase === "open" && !onchain ? CHIP.demo.label : c.label;
  return (
    <div
      className="flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-bold"
      style={{ ...glass, color: WC.text }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: c.tint,
          boxShadow: `0 0 9px ${c.tint}`,
          animation: c.pulse ? "wcPulse 1.6s ease-in-out infinite" : "none",
        }}
      />
      <span style={{ fontFamily: FONT_MONO }}>{label}</span>
    </div>
  );
}
