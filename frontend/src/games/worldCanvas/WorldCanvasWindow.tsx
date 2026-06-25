import { useState, type CSSProperties } from "react";
import type { GameWindowProps } from "../types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

/**
 * The lobby — a normal centered menu (not a canvas overlay), so it's the one screen
 * that adopts the shared arena {@link Card} + {@link Button} directly. No theme pin:
 * the shared components follow the app's light/dark toggle (light → white card, ink
 * title, violet CTA), matching the arena dashboard.
 */
function Lobby({ onSolo, onPvp }: { onSolo: () => void; onPvp: () => void }) {
  return (
    <div style={lobbyWrapStyle}>
      <Card
        className="w-[min(520px,100%)] items-center gap-5 text-center"
        style={{ boxShadow: WC.glow }}
      >
        <CardHeader className="w-full items-center px-6">
          <CardTitle className="wal-display w-full text-balance text-center text-[clamp(24px,4vw,32px)] font-bold leading-tight text-foreground">
            The World is Your Canvas
          </CardTitle>
        </CardHeader>
        <CardContent className="flex w-full flex-col gap-3 px-6">
          <Button
            onClick={onSolo}
            className="h-[54px] w-full text-base font-bold shadow-[var(--wal-glow)]"
          >
            🤖 Paint vs Bot
          </Button>
          <Button
            variant="secondary"
            onClick={onPvp}
            className="h-[50px] w-full text-[15px] font-bold"
          >
            🌐 Paint vs Player (Online)
          </Button>
        </CardContent>
      </Card>
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
    "radial-gradient(120% 100% at 50% -10%, color-mix(in srgb, var(--primary) 8%, var(--background)) 0%, var(--background) 60%)",
  fontFamily: FONT_DISPLAY,
  boxSizing: "border-box",
};

/** The floating "← Menu" overlay — theme-aware glass tokens (light in light mode, radius 0). */
const backButtonStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  left: 14,
  zIndex: 70,
  height: 34,
  padding: "0 14px",
  borderRadius: 0,
  border: `1px solid ${WC.glassBorder}`,
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 700,
  color: WC.text,
  background: WC.glass,
  boxShadow: WC.glow,
  backdropFilter: "blur(8px)",
  fontFamily: FONT_DISPLAY,
};
