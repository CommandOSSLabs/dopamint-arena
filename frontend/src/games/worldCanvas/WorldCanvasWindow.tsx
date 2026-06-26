import { useCallback, useState, useEffect, type CSSProperties } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import type { GameWindowProps } from "../types";
import { SketchDefs } from "../sketch";
import { CanvasView } from "./ui/CanvasView";
import { PvpCanvasView } from "./ui/PvpCanvasView";
import { MOVES_PER_GAME, MIN_MOVES_PER_GAME } from "./useWorldCanvasOnchain";
import "./ui/worldCanvas.sketch.css";

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
 * Everything renders under ONE persistent `.wc-sketch.sketch` root so the hand-drawn
 * chrome skin (ink-stroke borders + Gochi Hand text) and the single {@link SketchDefs}
 * roughen filter cascade to every floating overlay. The drawing canvas itself stays a
 * plain white surface — it never wears the sketch classes. The floating "← Menu"
 * overlays either mode (rendered here so neither view needs to know about the lobby);
 * leaving a mode unmounts its view and tears its tunnel down.
 */
export function WorldCanvasWindow({ windowId }: GameWindowProps) {
  // Open straight into the SOLO bot battle (it runs `auto=true`, so the two funded bots
  // start co-painting immediately and keep going) — mirroring the arena's other games,
  // which land on a live "watching bots" demo rather than a menu. The lobby (and PvP) is
  // one tap away via the floating "← Menu".
  const [mode, setMode] = useState<Mode>("solo");
  const account = useCurrentAccount();

  // Per-game settle cap (PvE): how many co-signed paints before the canvas wipes + the tunnel
  // settles and reopens. Chosen in the lobby (default = MOVES_PER_GAME = the max); applies to
  // the SOLO bot battle. PvP is unchanged.
  const [movesPerGame, setMovesPerGame] = useState(MOVES_PER_GAME);

  // Return to lobby on wallet disconnect (only if in pvp mode)
  useEffect(() => {
    if (!account && mode === "pvp") {
      setMode("menu");
    }
  }, [account, mode]);

  // Cabinet "Return to Home" (the shared GameCabinet Desktop wraps every window in): send the
  // solo canvas back to this lobby. Stable (setMode is stable) so the controller CanvasView
  // registers doesn't re-register every render.
  const goHome = useCallback(() => setMode("menu"), []);

  return (
    <div
      className="wc-sketch sketch"
      style={{ height: "100%", width: "100%", position: "relative" }}
    >
      <SketchDefs />
      {mode === "menu" ? (
        <Lobby
          connected={!!account}
          onSolo={() => setMode("solo")}
          onPvp={() => setMode("pvp")}
          movesPerGame={movesPerGame}
          onMovesPerGame={setMovesPerGame}
        />
      ) : (
        <>
          {mode === "solo" ? (
            <CanvasView onHome={goHome} movesPerGame={movesPerGame} />
          ) : (
            <PvpCanvasView windowId={windowId} />
          )}
          <button
            type="button"
            onClick={() => setMode("menu")}
            title="Back to menu"
            className="sketch-btn sketch-btn--ghost"
            style={backButtonStyle}
          >
            ← Menu
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The lobby — a centered hand-drawn card on the sketch paper, mirroring the arena's
 * other game menus (Quantum Poker's mode picker). The paper + ink come from the
 * `.wc-sketch.sketch` root; the card and its two CTAs are sketch primitives.
 */
function Lobby({
  connected,
  onSolo,
  onPvp,
  movesPerGame,
  onMovesPerGame,
}: {
  connected: boolean;
  onSolo: () => void;
  onPvp: () => void;
  movesPerGame: number;
  onMovesPerGame: (n: number) => void;
}) {
  return (
    <div className="sketch-welcome">
      <div className="sketch-welcome__card sketch-panel sketch-stroke">
        <div className="sketch-welcome__head">
          <span className="sketch-eyebrow">Infinite ink wall</span>
          <span className="sketch-title">The World is Your Canvas</span>
        </div>

        {/* Per-game settle cap (PvE): the canvas wipes + the tunnel settles every N co-signed
            paints. Drag to set N; the max is the default. PvP is unaffected. */}
        <label style={configRowStyle}>
          <span className="sketch-eyebrow">
            Paints / game · {movesPerGame.toLocaleString("en-US")}
          </span>
          <input
            type="range"
            min={MIN_MOVES_PER_GAME}
            max={MOVES_PER_GAME}
            step={1000}
            value={movesPerGame}
            onChange={(e) => onMovesPerGame(Number(e.target.value))}
            style={{ width: "100%" }}
            aria-label="Paints per game (settle cap)"
          />
        </label>

        <div className="sketch-welcome__actions">
          <button
            type="button"
            onClick={onSolo}
            className="sketch-btn sketch-btn--go"
          >
            🤖 Paint vs Bot
          </button>
          <button
            type="button"
            onClick={onPvp}
            disabled={!connected}
            className="sketch-btn"
          >
            🌐 Paint vs Player (Online)
          </button>
          {!connected && (
            <p className="text-center text-sm font-bold text-[#e03131] pt-2 uppercase tracking-wide">
              Please connect your Sui wallet in the top bar to paint.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Lobby config row — the per-game settle-cap slider + its live value. */
const configRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  width: "100%",
  margin: "4px 0 10px",
};

/** The floating "← Menu" overlay — only positioning here; the ink-stroke border, pastel
 *  fill and Gochi Hand text all come from the `.sketch-btn--ghost` skin. */
const backButtonStyle: CSSProperties = {
  position: "absolute",
  top: 14,
  left: 14,
  zIndex: 70,
};
