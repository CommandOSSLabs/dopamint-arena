import type { GameWindowProps } from "../types";
import { CanvasView } from "./ui/CanvasView";

/**
 * "The World is Your Canvas" — a shared, real-time, infinite pixel wall on the Sui
 * tunnel arena. Opening the game drops you STRAIGHT onto the live canvas, ready to
 * draw: no splash, no start menu. The mode is picked in-canvas by the SOLO / PVP pill
 * (mirroring the arena's other games), so there is no separate lobby screen to remove.
 *
 * - **SOLO** — the canvas mounted here: ONE strictly-2-party tunnel where two funded
 *   bots co-paint, and a single Auto toggle lets you take the wheel (author seat A vs
 *   the seat-B bot on the SAME tunnel). Each painted cell is one co-signed off-chain move.
 * - **PVP** (two distinct humans over the relay) is the next milestone — its Find-Match
 *   surfaces a clear "coming soon" note rather than faking a second human.
 *
 * The canvas opens its tunnel on mount and tears it down on unmount.
 */
export function WorldCanvasWindow(_props: GameWindowProps) {
  return <CanvasView />;
}
