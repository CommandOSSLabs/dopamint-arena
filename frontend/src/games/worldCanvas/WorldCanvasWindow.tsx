import type { GameWindowProps } from "../types";
import { SketchDefs } from "../sketch";
import { PvpCanvasView } from "./ui/PvpCanvasView";
import "./ui/worldCanvas.sketch.css";

/**
 * "The World is Your Canvas" — matchmake with another human and co-draw ONE shared
 * canvas over a genuine 2-party tunnel (each human owns a seat; half-signatures are
 * exchanged over the relay). Each painted cell is one co-signed move.
 *
 * Everything renders under ONE persistent `.wc-sketch.sketch` root so the hand-drawn
 * chrome skin (ink-stroke borders + Gochi Hand text) and the single {@link SketchDefs}
 * roughen filter cascade to every floating overlay. The drawing canvas itself stays a
 * plain white surface — it never wears the sketch classes. The idle screen shows a single
 * "Play" button; a remount mid-match resumes straight to the live board.
 */
export function WorldCanvasWindow({ windowId }: GameWindowProps) {
  return (
    <div
      className="wc-sketch sketch"
      style={{ height: "100%", width: "100%", position: "relative" }}
    >
      <SketchDefs />
      <PvpCanvasView windowId={windowId} />
    </div>
  );
}
