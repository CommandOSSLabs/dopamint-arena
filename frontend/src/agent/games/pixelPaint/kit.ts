import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  PixelPaintProtocol,
  type PixelPaintState,
  type PixelPaintMove,
  type PixelPaintConfig,
  type PixelPaintMode,
} from "sui-tunnel-ts/protocol/pixelPaint";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";
import { DESIGNS, projectDesignAt, type PixelDesign } from "./designs";
import { PixelPaintSceneBot } from "./sceneBot";

/** Canvas/protocol defaults — kept in sync with PixelPaintProtocol's own. */
const DEFAULT_WIDTH = 64;
const DEFAULT_HEIGHT = 64;

export interface PixelPaintKitConfig {
  width?: number;
  height?: number;
  /** Total placements after which the session is terminal. */
  cap?: number;
  /** Paints a single cell tolerates before it LOCKS. */
  overwriteLimit?: number;
  /** Amount shifted loser→winner on a decisive result. */
  stake?: bigint;
  /** War (default territory game), Scene (shared-stencil race), or Free (draw). */
  mode?: PixelPaintMode;
  /** WAR/FREE: bitmap the design-bot paints toward. Defaults to the Sui droplet. */
  target?: PixelDesign;
  /** WAR/FREE: where to plant the design (0..1). Default center; give two bots
   * different anchors so their art does not overlap. */
  anchor?: { x: number; y: number };
  /** SCENE only: the shared stencil both seats race to fill. A `PixelDesign`
   * (projected once, centered) or a pre-projected width*height Uint8Array. */
  scene?: PixelDesign | Uint8Array;
}

/**
 * A DESIGN-BOT: paints toward a target bitmap instead of random noise. Each
 * `plan` picks the not-yet-correct target cell nearest the canvas centre
 * (deterministic, raster-index tie-break) so the picture grows outward. Once the
 * design is complete but the cap isn't reached, it repaints in-design cells with
 * their target colour — every move still increments `placed`, so the protocol's
 * wire digest changes on every accepted move (satisfies the harness no-op guard).
 */
class PixelPaintDesignBot implements GameBot<PixelPaintState, PixelPaintMove> {
  private readonly seat: Party;
  private readonly target: PixelDesign;
  private readonly anchor: { x: number; y: number };
  /** Cached projection onto the live canvas dims; 0 = "don't care". */
  private projected: Uint8Array | null = null;
  private projW = 0;

  constructor(
    seat: Party,
    _ctx: BotContext,
    target: PixelDesign,
    anchor: { x: number; y: number },
  ) {
    this.seat = seat;
    this.target = target;
    this.anchor = anchor;
  }

  private project(state: PixelPaintState): Uint8Array {
    if (
      !this.projected ||
      this.projW !== state.width ||
      this.projected.length !== state.canvas.length
    ) {
      this.projected = projectDesignAt(
        this.target,
        state.width,
        state.height,
        this.anchor.x,
        this.anchor.y,
      );
      this.projW = state.width;
    }
    return this.projected;
  }

  plan(state: PixelPaintState): PixelPaintMove | null {
    if (state.winner !== 0) return null; // terminal
    const want = this.project(state);
    const W = state.width;
    const N = state.canvas.length;
    const limit = state.overwriteLimit;
    const cx = (W - 1) / 2;
    const cy = (state.height - 1) / 2;
    const mine = this.seat === "A" ? 1 : 2; // OWNER_A / OWNER_B
    const open = (i: number) => state.paints[i] < limit; // not yet locked

    // 1) CLAIM / FLIP / FIX: nearest open in-design cell not already mine-and-correct.
    let best = -1;
    let bestColor = 0;
    let bestKey = Infinity;
    for (let i = 0; i < N; i++) {
      const c = want[i];
      if (c === 0 || !open(i)) continue;
      if (state.owner[i] === mine && state.canvas[i] === c) continue;
      const x = i % W;
      const y = (i / W) | 0;
      const key = ((x - cx) * (x - cx) + (y - cy) * (y - cy)) * N + i;
      if (key < bestKey) {
        bestKey = key;
        best = i;
        bestColor = c;
      }
    }
    if (best >= 0) return { x: best % W, y: (best / W) | 0, color: bestColor };

    // 2) SECURE: reinforce my own open in-design cells toward their lock.
    best = -1;
    bestKey = Infinity;
    for (let i = 0; i < N; i++) {
      if (want[i] === 0 || !open(i) || state.owner[i] !== mine) continue;
      const x = i % W;
      const y = (i / W) | 0;
      const key = ((x - cx) * (x - cx) + (y - cy) * (y - cy)) * N + i;
      if (key < bestKey) {
        bestKey = key;
        best = i;
      }
    }
    if (best >= 0) return { x: best % W, y: (best / W) | 0, color: want[best] };

    // 3) FALLBACK: any open cell (lowest index) — guarantees progress to terminal.
    for (let i = 0; i < N; i++) {
      if (open(i)) return { x: i % W, y: (i / W) | 0, color: want[i] || 1 };
    }
    return null; // fully locked == terminal
  }

  confirm(_state: PixelPaintState, _move: PixelPaintMove): void {
    /* projection is canvas-derived; no per-move memory to advance. */
  }
  abort(): void {
    this.projected = null;
  }
}

export function createPixelPaintKit(
  config: PixelPaintKitConfig = {},
): GameKit<PixelPaintState, PixelPaintMove> {
  const mode: PixelPaintMode = config.mode ?? "war";
  const width = config.width ?? DEFAULT_WIDTH;
  const height = config.height ?? DEFAULT_HEIGHT;

  const protoConfig: PixelPaintConfig = {
    width,
    height,
    cap: config.cap,
    overwriteLimit: config.overwriteLimit,
    stake: config.stake,
    mode,
  };

  // SCENE: project the shared stencil ONCE and thread the SAME Uint8Array into
  // both the protocol (its committed target) and both PixelPaintSceneBot, so a
  // bot's decisions can never diverge from the on-wire stencil commitment.
  let stencil: Uint8Array | null = null;
  if (mode === "scene") {
    const scene = config.scene;
    if (!scene) throw new Error("scene mode requires a `scene` stencil");
    stencil =
      scene instanceof Uint8Array
        ? scene
        : projectDesignAt(scene, width, height, 0.5, 0.5);
    protoConfig.target = stencil;
  }

  const protocol = new PixelPaintProtocol(protoConfig);

  const designTarget = config.target ?? DESIGNS.suiDroplet;
  const anchor = config.anchor ?? { x: 0.5, y: 0.5 };

  return {
    id: "pixel-paint",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat, ctx) =>
      mode === "scene"
        ? new PixelPaintSceneBot(seat, ctx, stencil!)
        : new PixelPaintDesignBot(seat, ctx, designTarget, anchor),
    defaultStake: config.stake ?? 100n,
  };
}
