import { useMemo, useState, type CSSProperties } from "react";
import type { GameWindowProps } from "../types";
import { CanvasView } from "./ui/CanvasView";
import { WorldCanvasChrome } from "./ui/WorldCanvasChrome";
import { PALETTE, WC, FONT_DISPLAY, FONT_MONO } from "./ui/tokens";

/**
 * "The World is Your Canvas" — a shared, real-time, infinite pixel wall on the
 * Sui tunnel arena. A clean start menu (title + blurb + Start) hands off to the
 * live collaborative canvas, where each painted cell is one co-signed off-chain
 * move (≈ 1 TPS) and every "Agent AI" click spawns a bot that co-paints forever.
 *
 * The menu→game split mirrors the arena's other game windows: the menu owns its
 * own state; entering mounts {@link CanvasView}, which opens the tunnel; the back
 * button returns to the menu (and tears the tunnel down on unmount).
 */
export function WorldCanvasWindow(_props: GameWindowProps) {
  const [started, setStarted] = useState(false);
  return (
    <>
      <WorldCanvasChrome />
      {started ? (
        <div className="relative h-full min-h-0 w-full">
          {/* File ▸ Exit returns to the start menu (and tears the tunnel down). */}
          <CanvasView onExit={() => setStarted(false)} />
        </div>
      ) : (
        <StartMenu onStart={() => setStarted(true)} />
      )}
    </>
  );
}

type Twinkle = {
  key: number;
  left: string;
  top: string;
  size: string;
  color: string;
  dur: string;
  delay: string;
};

function makeTwinkles(): Twinkle[] {
  return Array.from({ length: 26 }, (_, i) => ({
    key: i,
    left: `${(Math.random() * 100).toFixed(1)}%`,
    top: `${(Math.random() * 100).toFixed(1)}%`,
    size: `${3 + Math.floor(Math.random() * 4)}px`,
    color: PALETTE[(i * 5) % PALETTE.length],
    dur: `${(2.2 + Math.random() * 2.8).toFixed(2)}s`,
    delay: `${(Math.random() * 3).toFixed(2)}s`,
  }));
}

const GRID_BACKDROP: CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "repeating-linear-gradient(0deg,transparent 0 23px,rgba(77,162,255,0.05) 23px 24px)," +
    "repeating-linear-gradient(90deg,transparent 0 23px,rgba(77,162,255,0.05) 23px 24px)",
  pointerEvents: "none",
  maskImage: "radial-gradient(120% 100% at 50% 32%, #000 38%, transparent 84%)",
  WebkitMaskImage:
    "radial-gradient(120% 100% at 50% 32%, #000 38%, transparent 84%)",
};

function StartMenu({ onStart }: { onStart: () => void }) {
  const twinkles = useMemo(makeTwinkles, []);
  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        width: "100%",
        overflow: "auto",
        background:
          "radial-gradient(130% 100% at 50% -10%, #112c4d 0%, #0a1730 32%, #06060c 72%)",
        fontFamily: FONT_DISPLAY,
        color: WC.text,
      }}
    >
      <div
        style={{
          position: "relative",
          minHeight: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 22,
          padding: 32,
          textAlign: "center",
          boxSizing: "border-box",
        }}
      >
        <div style={GRID_BACKDROP} aria-hidden />
        {twinkles.map((t) => (
          <div
            key={t.key}
            aria-hidden
            style={{
              position: "absolute",
              borderRadius: 2,
              pointerEvents: "none",
              left: t.left,
              top: t.top,
              width: t.size,
              height: t.size,
              background: t.color,
              animation: `wcTwinkle ${t.dur} ease-in-out ${t.delay} infinite`,
            }}
          />
        ))}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 16,
            zIndex: 1,
            animation: "wcRise .5s ease both",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "5px 14px",
              borderRadius: 999,
              border: "1px solid rgba(160,140,255,0.22)",
              background: "rgba(77,162,255,0.07)",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: WC.accent,
                boxShadow: `0 0 10px ${WC.accent}`,
              }}
            />
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: ".32em",
                textTransform: "uppercase",
                color: "#9fb6d6",
              }}
            >
              On-chain Pixel Wall
            </span>
          </div>
          <div
            style={{
              fontSize: 56,
              lineHeight: 1.02,
              fontWeight: 800,
              color: "#f3f6ff",
              letterSpacing: "-.03em",
              maxWidth: "20ch",
              animation: "wcGlow 3.5s ease-in-out infinite",
            }}
          >
            The World is Your Canvas
          </div>
          <p
            style={{
              margin: 0,
              maxWidth: "34rem",
              fontSize: 15.5,
              lineHeight: 1.6,
              color: "#93a0bd",
            }}
          >
            A shared, real-time, infinite pixel canvas. Place a cell in any color —
            each pixel is{" "}
            <span style={{ color: "#cdd8ef", fontWeight: 600 }}>
              one co-signed off-chain move
            </span>{" "}
            on the Sui tunnel. Press{" "}
            <span style={{ color: WC.accent, fontWeight: 700 }}>Agent AI</span> to
            spawn bots that co-paint alongside you forever — endless pixels,
            endless throughput.
          </p>
        </div>

        {/* color teaser row */}
        <div
          style={{
            display: "flex",
            gap: 6,
            zIndex: 1,
            animation: "wcRise .6s ease .08s both",
          }}
        >
          {PALETTE.map((hex, i) => (
            <span
              key={i}
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                background: hex,
                border: "1px solid rgba(0,0,0,0.3)",
              }}
            />
          ))}
        </div>

        <button
          onClick={onStart}
          style={{
            zIndex: 1,
            marginTop: 4,
            cursor: "pointer",
            border: "none",
            borderRadius: 14,
            padding: "14px 38px",
            fontFamily: "inherit",
            fontSize: 16,
            fontWeight: 800,
            color: "#06203B",
            background: WC.accent,
            boxShadow: "0 10px 34px rgba(77,162,255,0.5)",
            animation: "wcRise .6s ease .16s both",
          }}
        >
          Start painting →
        </button>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontSize: 11.5,
            color: "#5f6c87",
            zIndex: 1,
            fontFamily: FONT_MONO,
            animation: "wcRise .6s ease .22s both",
          }}
        >
          <span>∞ INFINITE WALL</span>
          <span style={{ opacity: 0.4 }}>|</span>
          <span>256×256 CHUNKS</span>
          <span style={{ opacity: 0.4 }}>|</span>
          <span>1 PIXEL = 1 TPS</span>
        </div>
      </div>
    </div>
  );
}
