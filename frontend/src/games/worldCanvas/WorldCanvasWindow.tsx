import { useState, type CSSProperties } from "react";
import type { GameWindowProps } from "../types";
import { CanvasView } from "./ui/CanvasView";
import { PvpCanvasView } from "./ui/PvpCanvasView";
import { WC, FONT_DISPLAY } from "./ui/tokens";

type Mode = "menu" | "solo" | "pvp";

/**
 * "The World is Your Canvas" — a shared, real-time, infinite ink wall on the Sui
 * tunnel arena. Opening the game shows a small lobby (mirroring the arena's other
 * games) to pick how you paint:
 *
 * - **Paint vs Bot** (SOLO) — {@link CanvasView}: ONE strictly-2-party tunnel where two
 *   funded bots co-paint; a single Auto toggle lets you take the wheel (author seat A
 *   vs the seat-B bot on the SAME tunnel). Each painted cell is one co-signed move.
 * - **Paint vs Player (Online)** (PVP) — {@link PvpCanvasView}: matchmake with another
 *   human and co-draw ONE shared canvas over a GENUINE 2-party tunnel (each human owns
 *   a seat; half-signatures are exchanged over the relay).
 *
 * The floating "← Menu" overlays either mode (rendered here so neither view needs to
 * know about the lobby); leaving a mode unmounts its view and tears its tunnel down.
 */
export function WorldCanvasWindow({ windowId }: GameWindowProps) {
  const [mode, setMode] = useState<Mode>("menu");

  if (mode === "menu") {
    return <Lobby onSolo={() => setMode("solo")} onPvp={() => setMode("pvp")} />;
  }

  return (
    <div style={{ height: "100%", width: "100%", position: "relative" }}>
      {mode === "solo" ? <CanvasView /> : <PvpCanvasView windowId={windowId} />}
      <button
        type="button"
        onClick={() => setMode("menu")}
        title="Back to menu"
        style={backButtonStyle}
      >
        ← Menu
      </button>
    </div>
  );
}

/** The lobby — a clean Excalidraw-meets-arena card with the two paint modes. */
function Lobby({ onSolo, onPvp }: { onSolo: () => void; onPvp: () => void }) {
  return (
    <div style={lobbyWrapStyle}>
      <div style={lobbyCardStyle}>
        <div style={lobbyKickerStyle}>● ON-CHAIN PIXEL WALL</div>
        <h1 style={lobbyTitleStyle}>The World is Your Canvas</h1>
        <p style={lobbyBlurbStyle}>
          A shared, real-time ink wall on the Sui tunnel — every stroke is a co-signed
          off-chain move (pure throughput). Paint alongside bots, or co-draw with
          another human over a genuine 2-party tunnel.
        </p>

        <button type="button" onClick={onSolo} style={primaryModeStyle}>
          🤖 Paint vs Bot
        </button>
        <button type="button" onClick={onPvp} style={secondaryModeStyle}>
          🌐 Paint vs Player (Online)
        </button>
      </div>
    </div>
  );
}

const lobbyWrapStyle: CSSProperties = {
  height: "100%",
  width: "100%",
  display: "grid",
  placeItems: "center",
  padding: 24,
  background:
    "radial-gradient(120% 100% at 50% -10%, #112c4d 0%, #0a1730 34%, #06060c 78%)",
  fontFamily: FONT_DISPLAY,
  boxSizing: "border-box",
};

const lobbyCardStyle: CSSProperties = {
  width: "min(440px, 100%)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 14,
  textAlign: "center",
  color: WC.text,
};

const lobbyKickerStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: ".22em",
  color: "#9fb6d6",
};

const lobbyTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 34,
  lineHeight: 1.05,
  fontWeight: 800,
  letterSpacing: "-.02em",
  color: "#f3f6ff",
};

const lobbyBlurbStyle: CSSProperties = {
  margin: "2px 0 10px",
  fontSize: 13.5,
  lineHeight: 1.55,
  color: "#93a0bd",
  maxWidth: "34rem",
};

const primaryModeStyle: CSSProperties = {
  width: "100%",
  height: 54,
  borderRadius: 14,
  border: "none",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 16,
  fontWeight: 800,
  color: "#06203B",
  background: WC.accent,
  boxShadow: "0 10px 30px rgba(77,162,255,0.45)",
};

const secondaryModeStyle: CSSProperties = {
  width: "100%",
  height: 50,
  borderRadius: 14,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 15,
  fontWeight: 700,
  color: WC.text,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.16)",
};

const backButtonStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  left: 14,
  zIndex: 70,
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
  fontFamily: FONT_DISPLAY,
};
