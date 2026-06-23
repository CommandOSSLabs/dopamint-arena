/**
 * The Paint app's bottom STATUS BAR — the natural home for the arena readouts that
 * make this a tunnel game: total pixels co-signed, live TPS, the active-tunnel
 * count (human + agents), and the on-chain/demo status chip. Sunken Win-98 cells,
 * mirroring how real Paint shows cursor + selection size down here. Render-only.
 */
import type { WorldCanvasPhase } from "../useWorldCanvasOnchain";
import {
  W98,
  FONT_W98,
  FONT_MONO,
  w98Inset,
} from "./tokens";

const PHASE: Record<WorldCanvasPhase, { label: string; tint: string; pulse: boolean }> = {
  idle: { label: "Idle", tint: W98.textDim, pulse: false },
  opening: { label: "Opening tunnel…", tint: "#9a6b00", pulse: true },
  open: { label: "On-chain · live", tint: "#0a7a3c", pulse: true },
  demo: { label: "Self-play · demo", tint: "#9a6b00", pulse: true },
  error: { label: "Error", tint: "#a31515", pulse: false },
};

function Cell({
  children,
  grow,
  title,
}: {
  children: React.ReactNode;
  grow?: boolean;
  title?: string;
}) {
  return (
    <div
      title={title}
      style={{
        ...w98Inset,
        flex: grow ? "1 1 auto" : "0 0 auto",
        height: 18,
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "0 7px",
        fontSize: 11,
        color: W98.text,
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

export function StatusBar({
  movesCoSigned,
  tps,
  agentCount,
  phase,
  onchain,
}: {
  movesCoSigned: number;
  tps: number;
  agentCount: number;
  phase: WorldCanvasPhase;
  onchain: boolean;
}) {
  const c = PHASE[phase];
  const label = phase === "open" && !onchain ? PHASE.demo.label : c.label;
  // A live human tunnel adds one to the agent spokes once the canvas is up.
  const tunnels = agentCount + (phase === "open" || phase === "demo" ? 1 : 0);

  return (
    <div
      style={{
        flex: "0 0 auto",
        background: W98.face,
        padding: "2px 2px",
        display: "flex",
        gap: 2,
        fontFamily: FONT_W98,
        boxShadow: `inset 1px 1px 0 ${W98.hilight}`,
      }}
    >
      <Cell title="Total pixels co-signed across all tunnels this run">
        <span style={{ color: W98.textDim }}>Pixels co-signed:</span>
        <span style={{ fontFamily: FONT_MONO, fontWeight: 700 }}>
          {movesCoSigned.toLocaleString()}
        </span>
      </Cell>
      <Cell title="Live throughput — co-signed paints per second">
        <span style={{ color: W98.textDim }}>TPS:</span>
        <span style={{ fontFamily: FONT_MONO, fontWeight: 700, color: "#0a7a3c" }}>
          {tps.toFixed(1)}
        </span>
      </Cell>
      <Cell title="Active 2-party tunnels: one per agent, plus your own">
        <span style={{ color: W98.textDim }}>Tunnels:</span>
        <span style={{ fontFamily: FONT_MONO, fontWeight: 700 }}>{tunnels}</span>
        <span style={{ color: W98.textDim }}>
          ({agentCount} bot{agentCount === 1 ? "" : "s"})
        </span>
      </Cell>
      <Cell grow title={`On-chain status: ${label}`}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: c.tint,
            boxShadow: `0 0 5px ${c.tint}`,
            flex: "0 0 auto",
            animation: c.pulse ? "wcPulse 1.6s ease-in-out infinite" : "none",
          }}
        />
        <span style={{ fontWeight: 700 }}>{label}</span>
      </Cell>
    </div>
  );
}
