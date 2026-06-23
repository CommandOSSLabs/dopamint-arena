import { useEffect, useRef, useState } from "react";
import { useWorldCanvasOnchain } from "../useWorldCanvasOnchain";
import { WorldCanvas } from "./WorldCanvas";
import { FloatingToolbar, AutoControl, type ToolId } from "./FloatingToolbar";
import { WC, FONT_DISPLAY } from "./tokens";

/** Eraser paints the board's lightest color (palette index 0 = white). */
const ERASER_COLOR = 0;

/**
 * The lean canvas shell: the chunked wall behind a single Excalidraw-style floating
 * toolbar (tools + a few colors + brush size) and the AUTO "Self-play (bots)"
 * control. No window chrome, no panels — every painted cell is one co-signed
 * off-chain move; each spawned agent co-paints forever over its own tunnel.
 */
export function CanvasView({ onExit }: { onExit?: () => void }) {
  const engine = useWorldCanvasOnchain();
  const [tool, setTool] = useState<ToolId>("draw");
  const [color, setColor] = useState(13); // Sui blue
  const [brushSize, setBrushSize] = useState(1);

  const tps = useRollingTps(engine.status.movesCoSigned);

  // The hand tool pans; the eraser paints white; everything else paints `color`.
  const panOnly = tool === "hand";
  const effectiveColor = tool === "erase" ? ERASER_COLOR : color;

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        position: "relative",
        overflow: "hidden",
        background: WC.bg,
        fontFamily: FONT_DISPLAY,
      }}
    >
      <WorldCanvas
        paints={engine.paints}
        revision={engine.revision}
        selectedColor={effectiveColor}
        brushSize={brushSize}
        panOnly={panOnly}
        disabled={engine.status.phase === "opening"}
        onPaint={engine.submitHumanPaint}
        agents={engine.agents}
        focus={engine.focus}
        humanAddress={engine.humanAddress}
      />

      <FloatingToolbar
        tool={tool}
        onTool={setTool}
        color={color}
        onColor={setColor}
        brushSize={brushSize}
        onBrushSize={setBrushSize}
      />

      <AutoControl
        agentCount={engine.agentCount}
        tps={tps}
        onSpawn={engine.spawnAgent}
        onStop={engine.stopAgents}
      />

      {onExit && (
        <button
          type="button"
          onClick={onExit}
          title="Back to menu"
          style={{
            position: "absolute",
            top: 14,
            left: 14,
            zIndex: 60,
            height: 34,
            padding: "0 14px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.14)",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 700,
            color: WC.text,
            background: "rgba(10,16,34,0.72)",
            backdropFilter: "blur(8px)",
          }}
        >
          ← Back
        </button>
      )}
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
