/**
 * Mix calculator (Deliverable C) — the *shape* of the on-chain bench experiment.
 *
 * Given a target peak off-chain TPS and a game mix, it answers: how many tunnels per
 * game, how many off-chain boxes, the on-chain ramp/drain time, the steady on-chain
 * settlement churn (must stay under the node's PTB/s budget), and the SUI bill.
 *
 * The three ceilings it reconciles (see docs/design/onchain-bench-pipeline.md):
 *   1. Off-chain compute — box move-TPS `C_G` (MEASURED by fleet-bench). Sets BOXES.
 *   2. On-chain PTB/s — the node does `NODE_PTB_S` PTBs/s; one PTB batches `B_OPEN`
 *      opens or `B_CLOSE` closes (MEASURED knees). Sets ramp/drain + churn ceiling.
 *   3. Per-tunnel play rate `mps` — GROUNDED to the box-saturation knee
 *      (≈ box move-TPS / SATURATION_KNEE), i.e. the box-efficient MAX rate ⇒ the
 *      MINIMUM tunnel count (≈ knee × boxes, scale-invariant). A fast load-test pace
 *      (genuine co-signing, not human-paced); a slower/realistic pace ⇒ proportionally
 *      MORE tunnels. Sets the tunnel COUNT, not the TPS. Per-game `mps` can override.
 *
 * Phase-separated model: OPEN all N (ramp) → PLAY (node idle, off-chain peak) → CLOSE
 * all N (drain). DEFAULT is multi-game **settle-once**: EVERY tunnel (carrier or variety)
 * opens once, plays many internal matches while held, and settles once at drain → no
 * mid-peak on-chain churn, lifetime tx ≈ 2·N. A finite-m tunnel finishing a match mid-peak
 * just starts the next one (carry balance, reset) — it does NOT close. An OPTIONAL
 * `--live-settles N` trickle deliberately rotates some variety tunnels for live on-chain
 * visibility, decoupled from the play rate and clamped to the node budget.
 *
 * Pure math, no chain. Run: `bun run plan` (from tools/loadbench/).
 */

// ── measured + assumed inputs ───────────────────────────────────────────────────

/** On-chain knees + node budget (PTBs/s). B_* measured on localnet 2026-06-29. */
export const B_OPEN = 255;
export const B_CLOSE = 681;
export const NODE_PTB_S = 300;
/** Hard cap on concurrent tunnels we can afford to create for the experiment (operational
 *  constraint). The plan flags any target+mix that exceeds it. */
export const MAX_AFFORDABLE_TUNNELS = 100_000;
/** Net per-tx gas (SUI), measured on testnet (authoritative over localnet comp). */
export const OPEN_SUI = 0.004374;
export const CLOSE_SUI = 0.003809;

/** A c7i.48xlarge has 192 vCPU vs the M4's 14 cores; CPU-bound + ~linear in cores.
 *  Rough — x86 vs ARM per-core differs — so treat as an order-of-magnitude scale. */
export const AWS_SCALE = 192 / 14;

/** Serve oversubscription knee (MEASURED, serve_throughput_probe 2026-06-29): a box hits
 *  ~93–97% of its sync move-TPS ceiling at ≳200 async tunnels (1 tokio task/party); fewer leaves
 *  cores idle on the ping-pong (14 tunnels → only ~43%). So ~200 tunnels/box is the FEWEST that
 *  keeps a box loaded — the minimal-tunnel operating point. `mps = box move-TPS / KNEE` ≈ 800. */
export const SATURATION_KNEE = 200;

export interface GamePerf {
  /** MEASURED box aggregate play move-TPS (fleet-bench, M4 14-core, 2026-06-29). */
  moveTpsBox: number;
  /** MEASURED moves per tunnel (∞ for no-mid-stream-settle carriers). */
  m: number;
  /** Optional per-tunnel mps override. Default = `moveTpsBox / SATURATION_KNEE` (the
   *  box-saturation rate → minimal tunnels). Set only to model a deliberately slower pace. */
  mps?: number;
  role: "carrier" | "variety";
}

/** The fleet-bench M4 table. Carriers' `m` is set ∞ (bench caps them at 1000, but
 *  chat/cross/world-canvas never settle mid-stream — rolling digest). `mps` is derived
 *  (box-saturation knee) unless overridden — see {@link mpsOf}. */
export const GAMES: Record<string, GamePerf> = {
  "chat.v1": { moveTpsBox: 165508, m: Infinity, role: "carrier" },
  "cross.v1": { moveTpsBox: 168837, m: Infinity, role: "carrier" },
  "world_canvas.cell.v1": { moveTpsBox: 167123, m: Infinity, role: "carrier" },
  "blackjack.bet.v1": { moveTpsBox: 168257, m: 236, role: "variety" },
  "quantum_poker.v2": { moveTpsBox: 135939, m: 58, role: "variety" },
  "battleship.v1": { moveTpsBox: 151059, m: 103, role: "variety" },
};

/** Per-tunnel mps: the override if set, else the box-saturation rate `moveTpsBox / KNEE`
 *  (≈ 800) — the box-efficient max ⇒ minimum tunnels. Lower it to model a slower pace. */
export function mpsOf(game: string): number {
  const g = GAMES[game];
  if (!g) throw new Error(`unknown game ${game}`);
  return g.mps ?? g.moveTpsBox / SATURATION_KNEE;
}

/** Carriers-heavy default mix (shares of the target; must sum to 1). */
export const DEFAULT_MIX: Record<string, number> = {
  "chat.v1": 0.5,
  "cross.v1": 0.3,
  "world_canvas.cell.v1": 0.12,
  "blackjack.bet.v1": 0.04,
  "quantum_poker.v2": 0.02,
  "battleship.v1": 0.02,
};

// ── model ───────────────────────────────────────────────────────────────────────

export interface GameRow {
  game: string;
  role: string;
  share: number;
  offchainTps: number;
  /** Concurrent tunnels of this game (opened once at ramp, held the whole peak, settled once
   *  at drain — multi-game/settle-once; a tunnel plays many internal matches, no mid-peak close). */
  tunnels: number;
  /** Off-chain boxes (this game's share of compute). */
  boxes: number;
  /** Internal match length (s) = m/mps; Infinity for carriers. NOT an on-chain settle interval in
   *  the default (settle-once) model — only the rate at which a tunnel COULD rotate if opted in. */
  matchLifeS: number;
  /** Max mid-peak settles/s if this game's tunnels fully rotated (tunnels/matchLifeS; 0 for carriers).
   *  The ceiling the optional live-settles trickle draws from; not incurred by default. */
  maxChurnPerSec: number;
}

export interface MixPlan {
  target: number;
  scale: number;
  durationS: number;
  rows: GameRow[];
  totalTunnels: number;
  totalBoxes: number;
  rampS: number;
  drainS: number;
  /** Deliberate live-settlement trickle (settles/s) during the peak. 0 = pure settle-once
   *  (default): every tunnel opens once + closes once, no mid-peak on-chain activity. */
  liveSettlesPerSec: number;
  /** Ceiling the trickle could reach (sum of per-game maxChurnPerSec); liveSettlesPerSec is clamped to it. */
  maxChurnPerSec: number;
  churnPtbPerSec: number;
  nodeUtilPeakPct: number;
  /** Lifetime tx + SUI: N opens + N closes (settle-once base) + 2 per trickle rotation. */
  totalOpens: number;
  totalCloses: number;
  suiCost: number;
  /** False if totalTunnels exceeds MAX_AFFORDABLE_TUNNELS (operational cap). */
  affordable: boolean;
}

function planGame(
  game: string,
  share: number,
  target: number,
  scale: number,
): GameRow {
  const g = GAMES[game];
  if (!g) throw new Error(`unknown game ${game}`);
  const mps = mpsOf(game);
  const offchainTps = share * target;
  const tunnels = Math.ceil(offchainTps / mps);
  const boxes = offchainTps / (g.moveTpsBox * scale);
  const matchLifeS = g.m === Infinity ? Infinity : g.m / mps;
  // Settle-once default: a tunnel is held the whole peak (multi-game) and settled once at drain,
  // so it incurs NO mid-peak churn. maxChurnPerSec is only the ceiling an opt-in trickle could use.
  const maxChurnPerSec = matchLifeS === Infinity ? 0 : tunnels / matchLifeS;
  return { game, role: g.role, share, offchainTps, tunnels, boxes, matchLifeS, maxChurnPerSec };
}

export function planMix(
  target: number,
  mix: Record<string, number>,
  opts: { scale?: number; durationS?: number; liveSettlesPerSec?: number } = {},
): MixPlan {
  const scale = opts.scale ?? 1;
  const durationS = opts.durationS ?? 60;
  const shareSum = Object.values(mix).reduce((a, b) => a + b, 0);
  if (Math.abs(shareSum - 1) > 1e-6)
    throw new Error(`mix shares must sum to 1 (got ${shareSum.toFixed(4)})`);

  const rows = Object.entries(mix).map(([game, share]) =>
    planGame(game, share, target, scale),
  );
  const totalTunnels = rows.reduce((a, r) => a + r.tunnels, 0);
  const totalBoxes = rows.reduce((a, r) => a + r.boxes, 0);
  // Default model: multi-game settle-once → no rotation. An optional deliberate trickle
  // (liveSettlesPerSec) closes+reopens some variety tunnels for live on-chain visibility,
  // decoupled from the play mps, and clamped to what the variety pool can actually sustain.
  const maxChurnPerSec = rows.reduce((a, r) => a + r.maxChurnPerSec, 0);
  const liveSettlesPerSec = Math.min(opts.liveSettlesPerSec ?? 0, maxChurnPerSec);
  const churnPtbPerSec = liveSettlesPerSec * (1 / B_OPEN + 1 / B_CLOSE);
  // Ramp/drain: open (resp. close) all N tunnels at the node's batched ceiling.
  const rampS = totalTunnels / (NODE_PTB_S * B_OPEN);
  const drainS = totalTunnels / (NODE_PTB_S * B_CLOSE);
  // Lifetime tx: N opens + N closes (every tunnel, once) + one open+close per deliberate rotation.
  const rotations = liveSettlesPerSec * durationS;
  const totalOpens = totalTunnels + rotations;
  const totalCloses = totalTunnels + rotations;
  const suiCost = totalOpens * OPEN_SUI + totalCloses * CLOSE_SUI;

  return {
    target,
    scale,
    durationS,
    rows,
    totalTunnels,
    totalBoxes,
    rampS,
    drainS,
    liveSettlesPerSec,
    maxChurnPerSec,
    churnPtbPerSec,
    nodeUtilPeakPct: (churnPtbPerSec / NODE_PTB_S) * 100,
    totalOpens,
    totalCloses,
    suiCost,
    affordable: totalTunnels <= MAX_AFFORDABLE_TUNNELS,
  };
}

// ── render ──────────────────────────────────────────────────────────────────────

const int = (n: number) => Math.round(n).toLocaleString("en-US");
const f1 = (n: number) => n.toFixed(1);

export function renderPlan(p: MixPlan): string {
  const out: string[] = [];
  const boxLabel = p.scale === 1 ? "M4-boxes" : `boxes(${f1(p.scale)}× M4)`;
  out.push(
    `### Target ${int(p.target)} off-chain TPS  ·  peak ${p.durationS}s  ·  scale ${f1(p.scale)}×`,
  );
  out.push("");
  out.push(
    `| game | role | share | off-chain TPS | tunnels | ${boxLabel} | match s | max settles/s |`,
  );
  out.push(
    `|------|------|------:|--------------:|--------:|----------:|-------:|--------------:|`,
  );
  for (const r of p.rows) {
    out.push(
      `| ${r.game} | ${r.role} | ${(r.share * 100).toFixed(0)}% | ${int(r.offchainTps)} | ` +
        `${int(r.tunnels)} | ${r.boxes.toFixed(2)} | ${r.matchLifeS === Infinity ? "∞" : f1(r.matchLifeS)} | ` +
        `${r.maxChurnPerSec === 0 ? "—" : int(r.maxChurnPerSec)} |`,
    );
  }
  out.push("");
  out.push(
    "_Settle-once (multi-game): every tunnel opens once at ramp, plays many internal matches, " +
      "settles once at drain → no mid-peak on-chain churn. `match s` = internal match length (info); " +
      "`max settles/s` = the live-settle trickle a game COULD sustain if opted in._",
  );
  out.push(`- **Total tunnels (concurrent):** ${int(p.totalTunnels)}` +
    (p.affordable ? "" : `  ⚠️ EXCEEDS the ${int(MAX_AFFORDABLE_TUNNELS)}-tunnel cap`));
  out.push(
    `- **Off-chain boxes:** ${p.totalBoxes.toFixed(2)} ${boxLabel}` +
      (p.scale === 1
        ? `  →  ${(p.totalBoxes / AWS_SCALE).toFixed(2)} c7i.48xlarge-equiv`
        : ""),
  );
  out.push(
    `- **On-chain ramp (open all N):** ${f1(p.rampS)}s   ·   **drain (close all N):** ` +
      `${f1(p.drainS)}s   (node idle during the peak)`,
  );
  if (p.liveSettlesPerSec > 0) {
    out.push(
      `- **Live-settle trickle (opt-in):** ${int(p.liveSettlesPerSec)} settles/s = ` +
        `${f1(p.churnPtbPerSec)} PTB/s → **${f1(p.nodeUtilPeakPct)}% of the ${NODE_PTB_S}-PTB/s node** ` +
        `(of ${int(p.maxChurnPerSec)}/s max available)`,
    );
  } else {
    out.push(`- **Mid-peak on-chain:** none (settle-once). Opt in with \`--live-settles N\` for a visible trickle (≤ ${int(p.maxChurnPerSec)}/s).`);
  }
  out.push(
    `- **Lifetime tx:** ${int(p.totalOpens)} opens + ${int(p.totalCloses)} closes  ·  ` +
      `**SUI:** ${p.suiCost.toFixed(1)} (≈ ${(p.suiCost / p.totalTunnels).toFixed(5)}/tunnel)`,
  );
  if (p.churnPtbPerSec > NODE_PTB_S)
    out.push(`-   ⚠️ trickle EXCEEDS the ${NODE_PTB_S}-PTB/s node budget — lower --live-settles`);
  out.push("");
  return out.join("\n");
}

// ── cli ─────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  targets: number[];
  scale: number;
  durationS: number;
  liveSettlesPerSec: number;
} {
  let targets = [1_000_000, 2_000_000, 10_000_000];
  let scale = 1;
  let durationS = 60;
  let liveSettlesPerSec = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--targets") targets = argv[++i].split(",").map((s) => Number(s.trim()));
    else if (a === "--scale") scale = Number(argv[++i]);
    else if (a === "--aws") scale = AWS_SCALE;
    else if (a === "--duration") durationS = Number(argv[++i]);
    else if (a === "--live-settles") liveSettlesPerSec = Number(argv[++i]);
    else throw new Error(`unknown flag ${a}`);
  }
  return { targets, scale, durationS, liveSettlesPerSec };
}

export function main(argv: string[]): void {
  const { targets, scale, durationS, liveSettlesPerSec } = parseArgs(argv);
  const lines: string[] = [];
  lines.push("# Bench mix plan — carriers-heavy, multi-game settle-once");
  lines.push("");
  lines.push(
    `Mix: ${Object.entries(DEFAULT_MIX)
      .map(([g, s]) => `${g} ${(s * 100).toFixed(0)}%`)
      .join(", ")}`,
  );
  lines.push(
    `Knees B_open=${B_OPEN} B_close=${B_CLOSE}, node=${NODE_PTB_S} PTB/s. ` +
      `Box move-TPS + m: fleet-bench M4 (scale ${f1(scale)}×). ` +
      `mps = box move-TPS / ${SATURATION_KNEE} (serve-saturation knee) ⇒ MINIMUM tunnels (≈${SATURATION_KNEE}×boxes); ` +
      `fast load-test pace (genuine co-sign), not human-paced — slower pace ⇒ more tunnels.`,
  );
  lines.push(
    `Model: multi-game **settle-once** (open once → hold/play → close once at drain; no mid-peak ` +
      `churn). Affordability cap ${int(MAX_AFFORDABLE_TUNNELS)} tunnels. ` +
      (liveSettlesPerSec > 0 ? `Live-settle trickle: ${int(liveSettlesPerSec)}/s.` : `No trickle (--live-settles to opt in).`),
  );
  lines.push("");
  for (const t of targets) {
    lines.push(renderPlan(planMix(t, DEFAULT_MIX, { scale, durationS, liveSettlesPerSec })));
  }
  process.stdout.write(lines.join("\n") + "\n");
}

if (import.meta.main) main(process.argv.slice(2));
