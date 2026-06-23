import { useEffect, useRef, useState } from "react";
import { useWorldCanvasOnchain } from "../useWorldCanvasOnchain";
import { WorldCanvas } from "./WorldCanvas";
import {
  FloatingToolbar,
  ArenaControl,
  MostPainted,
  type ToolId,
} from "./FloatingToolbar";
import { WC, FONT_DISPLAY } from "./tokens";

/** Eraser co-signs a real move under this index; it RENDERS in the backdrop color
 *  (handled in WorldCanvas via `erasing`), so the index itself is never seen. */
const ERASER_COLOR = 3;

/** Selectable canvas backdrops (Excalidraw-style): a few presets, not a free picker. */
const BACKGROUNDS: readonly string[] = [
  WC.board, // dark navy (default)
  "#0a0a0f", // near-black
  "#1e293b", // slate
  "#f6f3ea", // paper
  "#ffffff", // white
];

/**
 * The lean canvas shell — opening the game lands you straight here, ready to draw (no
 * splash, no start menu, no mode picker). The chunked wall sits behind one
 * Excalidraw-style floating toolbar (tools + a few colors + brush size + backdrop), the
 * {@link ArenaControl} Auto "take the wheel" toggle, and the {@link MostPainted} readout.
 * Every painted cell is one co-signed off-chain move on the ONE strictly-2-party tunnel;
 * free/draw, so the only score is who painted the most.
 */
export function CanvasView() {
  const engine = useWorldCanvasOnchain();
  const [tool, setTool] = useState<ToolId>("draw");
  const [color, setColor] = useState(13); // Sui blue
  const [brushSize, setBrushSize] = useState(1);
  const [background, setBackground] = useState<string>(WC.board);

  const tps = useRollingTps(engine.status.movesCoSigned);

  // The hand tool pans; the eraser renders the backdrop; everything else paints `color`.
  // The wall is pan-only (watch) while Auto is on or while the hand tool is picked — flip
  // Auto off to take the wheel and paint seat A.
  const panOnly = tool === "hand" || engine.auto;
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
        background={background}
        erasing={tool === "erase"}
      />

      <FloatingToolbar
        tool={tool}
        onTool={setTool}
        color={color}
        onColor={setColor}
        brushSize={brushSize}
        onBrushSize={setBrushSize}
        background={background}
        backgrounds={BACKGROUNDS}
        onBackground={setBackground}
      />

      <ArenaControl
        auto={engine.auto}
        tps={tps}
        onToggleAuto={engine.toggleAuto}
        onViewNext={engine.viewNextAgent}
      />

      <MostPainted painters={engine.painters} />
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
