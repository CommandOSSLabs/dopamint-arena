import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type {
  PixelPaintState,
  PixelPaintMove,
} from "sui-tunnel-ts/protocol/pixelPaint";
import { type BotContext, type GameBot } from "@/agent/gameKit";

/**
 * A SCENE-BOT: both seats share the SAME stencil and race to lay the LOCKING
 * paint on each cell (the protocol banks a cell's correctness to whoever locks
 * it at the required color). Every plan is legal by construction — it only ever
 * names a stencil cell at its required color — and never a no-op, since each
 * accepted paint increments `paints[idx]` and so changes the wire digest. The
 * plan covers every still-open stencil cell, so the stencil locks within
 * `targetCellCount * overwriteLimit` paints and the scene always settles. There
 * is deliberately NO off-stencil fallback: off-scene cells are unpaintable.
 */
export class PixelPaintSceneBot
  implements GameBot<PixelPaintState, PixelPaintMove>
{
  /** This seat's owner mark: OWNER_A (1) or OWNER_B (2). */
  private readonly mine: number;
  /** Shared stencil, length width*height: 0 = background, 1..N = required color. */
  private readonly stencil: Uint8Array;

  constructor(seat: Party, _ctx: BotContext, stencil: Uint8Array) {
    this.mine = seat === "A" ? 1 : 2;
    this.stencil = stencil;
  }

  plan(state: PixelPaintState): PixelPaintMove | null {
    if (state.winner !== 0) return null; // terminal
    const W = state.width;
    const N = state.canvas.length;
    const limit = state.overwriteLimit;
    const cx = (W - 1) / 2;
    const cy = (state.height - 1) / 2;
    // An "open" target cell: on the stencil and not yet locked.
    const open = (i: number) =>
      this.stencil[i] !== 0 && state.paints[i] < limit;
    // Nearest-to-center wins, raster index breaks ties (matches the war bot).
    const key = (i: number) => {
      const x = i % W;
      const y = (i / W) | 0;
      return ((x - cx) * (x - cx) + (y - cy) * (y - cy)) * N + i;
    };

    // 1) CLAIM / STEAL: nearest open stencil cell I do not own — grab its lock.
    let best = -1;
    let bestKey = Infinity;
    for (let i = 0; i < N; i++) {
      if (!open(i) || state.owner[i] === this.mine) continue;
      const k = key(i);
      if (k < bestKey) {
        bestKey = k;
        best = i;
      }
    }

    // 2) SECURE: else nearest open stencil cell I already own — drive it to lock.
    if (best < 0) {
      for (let i = 0; i < N; i++) {
        if (!open(i) || state.owner[i] !== this.mine) continue;
        const k = key(i);
        if (k < bestKey) {
          bestKey = k;
          best = i;
        }
      }
    }

    // 3) Else: every stencil cell is locked — the scene is settled.
    if (best < 0) return null;
    return { x: best % W, y: (best / W) | 0, color: this.stencil[best] };
  }

  confirm(_state: PixelPaintState, _move: PixelPaintMove): void {
    /* stencil is immutable; every decision is a pure function of confirmed state. */
  }
  abort(): void {
    /* no retained memory to tear down. */
  }
}
