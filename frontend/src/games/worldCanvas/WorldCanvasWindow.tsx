import { useMemo, useState, type CSSProperties } from "react";
import type { GameWindowProps } from "../types";
import { CanvasView } from "./ui/CanvasView";
import { PALETTE, WC, FONT_DISPLAY, FONT_MONO } from "./ui/tokens";

/** Keyframes the lobby animates against (rise/glow/twinkle). Inlined here so there's
 *  no separate chrome component — the lean live canvas needs none. */
const MENU_KEYFRAMES = `
  @keyframes wcRise { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: none } }
  @keyframes wcGlow { 0%,100% { text-shadow: 0 0 22px rgba(77,162,255,0.35) } 50% { text-shadow: 0 0 40px rgba(77,162,255,0.6) } }
  @keyframes wcTwinkle { 0%,100% { opacity: 0.15; transform: scale(0.8) } 50% { opacity: 0.9; transform: scale(1.15) } }
`;

/** Which screen the window is on: the lobby chooser, the live SOLO canvas, or the
 *  PvP matching screen (a coming-soon stub — the relay handshake isn't wired yet). */
type Mode = "solo" | "pvp" | null;

/**
 * "The World is Your Canvas" — a shared, real-time, infinite pixel wall on the Sui
 * tunnel arena. The window mirrors the arena's other games (chicken-cross / bomb-it):
 * a SOLO / PVP lobby hands off to the mode.
 *
 * - **SOLO** mounts {@link CanvasView}: ONE strictly-2-party tunnel — two funded bots
 *   co-paint it, and a single Auto toggle lets you take the wheel (author seat A vs the
 *   seat-B bot on the SAME tunnel). Each painted cell is one co-signed off-chain move.
 * - **PVP** (two distinct humans over the relay) is the next milestone, so its
 *   Find-Match surfaces a clear "coming soon" screen rather than faking a second human.
 *
 * The lobby owns its own state; entering SOLO mounts the canvas (which opens the
 * tunnel); Back returns to the lobby (and tears the tunnel down on unmount).
 */
export function WorldCanvasWindow(_props: GameWindowProps) {
  const [mode, setMode] = useState<Mode>(null);
  return (
    <>
      <style>{MENU_KEYFRAMES}</style>
      {mode === "solo" ? (
        <div className="relative h-full min-h-0 w-full">
          {/* Back returns to the lobby (and tears the tunnel down on unmount). */}
          <CanvasView onExit={() => setMode(null)} />
        </div>
      ) : (
        <Lobby
          matching={mode === "pvp"}
          onSolo={() => setMode("solo")}
          onFind={() => setMode("pvp")}
          onCancel={() => setMode(null)}
        />
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

/**
 * The cosmic lobby — a SOLO / PVP chooser on the starfield backdrop, mirroring the
 * arena's other game windows. SOLO leads to the live canvas; PVP's Find-Match opens
 * the coming-soon matching screen (the relay handshake is the next milestone).
 */
function Lobby({
  matching,
  onSolo,
  onFind,
  onCancel,
}: {
  /** True once Find-Match has been clicked — show the PvP coming-soon screen. */
  matching: boolean;
  /** Enter SOLO: mount the canvas (opens the one 2-party tunnel; two bots co-paint). */
  onSolo: () => void;
  /** PvP Find-Match: surface the coming-soon matching screen. */
  onFind: () => void;
  /** Cancel matching / back to the chooser. */
  onCancel: () => void;
}) {
  const twinkles = useMemo(makeTwinkles, []);
  const [tab, setTab] = useState<"solo" | "pvp">("solo");

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
              fontSize: 52,
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
        </div>

        {matching ? (
          <PvpMatching onCancel={onCancel} />
        ) : (
          <LobbyChooser tab={tab} onTab={setTab} onSolo={onSolo} onFind={onFind} />
        )}

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

/** The SOLO / PVP segmented chooser + the active tab's blurb and call-to-action. */
function LobbyChooser({
  tab,
  onTab,
  onSolo,
  onFind,
}: {
  tab: "solo" | "pvp";
  onTab: (t: "solo" | "pvp") => void;
  onSolo: () => void;
  onFind: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 18,
        zIndex: 1,
        width: "min(34rem, 100%)",
        animation: "wcRise .6s ease .08s both",
      }}
    >
      <div style={segStyle}>
        <SegTab label="Solo" active={tab === "solo"} onClick={() => onTab("solo")} />
        <SegTab label="PvP" active={tab === "pvp"} onClick={() => onTab("pvp")} />
      </div>

      {tab === "solo" ? (
        <>
          <p style={blurbStyle}>
            Two funded bots paint a shared wall over a real Sui tunnel —{" "}
            <span style={emStyle}>one signature funds both seats</span>. Each pixel is
            one co-signed off-chain move. Take the wheel anytime with the{" "}
            <span style={{ color: WC.accent, fontWeight: 700 }}>Auto</span> toggle to
            draw seat A yourself.
          </p>
          {/* color teaser row */}
          <div style={{ display: "flex", gap: 6 }}>
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
          <button onClick={onSolo} style={ctaStyle}>
            Start painting →
          </button>
        </>
      ) : (
        <>
          <p style={blurbStyle}>
            Find a match with another painter over the relay —{" "}
            <span style={emStyle}>two distinct humans, one shared tunnel</span>. Every
            stroke you both lay is co-signed on the same 2-party tunnel.
          </p>
          <button onClick={onFind} style={ctaStyle}>
            Find Match
          </button>
        </>
      )}
    </div>
  );
}

/** The PvP coming-soon screen — the relay matchmaking handshake is the next milestone,
 *  so rather than fake a second human this surfaces the lane with an honest note. */
function PvpMatching({ onCancel }: { onCancel: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
        zIndex: 1,
        width: "min(34rem, 100%)",
        animation: "wcRise .4s ease both",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "7px 16px",
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,0.14)",
          background: "rgba(10,16,34,0.55)",
          fontFamily: FONT_MONO,
          fontSize: 12.5,
          fontWeight: 700,
          letterSpacing: ".08em",
          color: "#cdd8ef",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: WC.seatB,
            boxShadow: `0 0 10px ${WC.seatB}`,
          }}
        />
        PVP RELAY · COMING SOON
      </div>
      <p style={blurbStyle}>
        Matchmaking two distinct humans over the relay is the next milestone. For now,
        flip{" "}
        <span style={{ color: WC.accent, fontWeight: 700 }}>Auto off</span> in Solo to
        take the wheel against the seat-B bot on a real shared tunnel.
      </p>
      <button onClick={onCancel} style={ghostCtaStyle}>
        ← Back
      </button>
    </div>
  );
}

/** One tab of the SOLO / PVP segmented control. */
function SegTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        minWidth: 92,
        height: 34,
        padding: "0 18px",
        borderRadius: 9,
        border: "none",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 13.5,
        fontWeight: 800,
        color: active ? "#06203B" : "#cdd8ef",
        background: active ? WC.accent : "transparent",
        transition: "background .12s, color .12s",
      }}
    >
      {label}
    </button>
  );
}

const segStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: 4,
  borderRadius: 12,
  background: "rgba(10,16,34,0.6)",
  border: "1px solid rgba(255,255,255,0.12)",
};

const blurbStyle: CSSProperties = {
  margin: 0,
  maxWidth: "34rem",
  fontSize: 15,
  lineHeight: 1.6,
  color: "#93a0bd",
};

const emStyle: CSSProperties = {
  color: "#cdd8ef",
  fontWeight: 600,
};

const ctaStyle: CSSProperties = {
  marginTop: 2,
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
};

const ghostCtaStyle: CSSProperties = {
  cursor: "pointer",
  borderRadius: 12,
  padding: "11px 26px",
  fontFamily: "inherit",
  fontSize: 14,
  fontWeight: 700,
  color: WC.text,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.16)",
};
