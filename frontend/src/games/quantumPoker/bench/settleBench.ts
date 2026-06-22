// Report benchmark for Quantum Poker settlement. For each hand cap it plays a full self-play
// tunnel OFF-CHAIN, uploads the transcript blob (what /settle archives) to the Walrus publisher,
// and prints a markdown table of the hand_cap ↔ size ↔ play/settle time ↔ TPS correlation, then
// fits the upload cost and derives the size sweet spot + TPS ceilings.
//
// Run (from frontend/), redirect to a file for the report:
//   node --import tsx src/games/quantumPoker/bench/settleBench.ts > bench.md
//   node --import tsx src/games/quantumPoker/bench/settleBench.ts 50 200 800 1600   # custom caps
//   WALRUS_PUBLISHER_URL=https://... node --import tsx .../settleBench.ts            # real publisher
//
// Pure off-chain + a Walrus PUT — no settler key, no gas. The on-chain close is O(1) and constant,
// so the variable is the transcript size, which scales linearly with the hand cap.
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { keyPairFromRng, ed25519Address } from "sui-tunnel-ts/core/crypto";
import {
  QuantumPokerProtocol,
  type PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import {
  makeSeatBot,
  runPokerSelfPlayToEnd,
  LIVE_BOT_CONTEXT,
  type PokerTunnel,
} from "../pokerSelfPlay";

const PUBLISHER = (
  process.env.WALRUS_PUBLISHER_URL ??
  "https://publisher.walrus-testnet.walrus.space"
).replace(/\/$/, "");
const STAKE = 10_000n;
const ARGV = process.argv.slice(2).map(Number).filter((n) => n > 0);
const SWEEP = ARGV.length > 0 ? ARGV : [25, 50, 100, 200, 400, 800, 1600, 3200];

function mulberry32(seed: number): () => number {
  let v = seed;
  return () => {
    v |= 0;
    v = (v + 0x6d2b79f5) | 0;
    let t = Math.imul(v ^ (v >>> 15), 1 | v);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n: number, d = 2): string => n.toFixed(d);

function playTunnel(handCap: number): {
  transcript: Transcript;
  tunnel: PokerTunnel;
  playMs: number;
} {
  const keyRng = mulberry32(0xc0ffee + handCap);
  const a = keyPairFromRng(keyRng);
  const b = keyPairFromRng(keyRng);
  const tunnelId = "0x" + "5b".repeat(32);
  const protocol = new QuantumPokerProtocol(BigInt(handCap));
  const tunnel = OffchainTunnel.selfPlay(
    protocol,
    tunnelId,
    a,
    b,
    ed25519Address(a.publicKey),
    ed25519Address(b.publicKey),
    { a: STAKE, b: STAKE },
  ) as PokerTunnel;
  const transcript = new Transcript(tunnelId);
  tunnel.onUpdate = (u) => transcript.append(u);
  const botA = makeSeatBot("A", STAKE, BigInt(handCap), { name: "Nari", persona: "tight" }, LIVE_BOT_CONTEXT);
  const botB = makeSeatBot("B", STAKE, BigInt(handCap), { name: "Jules", persona: "loose" }, LIVE_BOT_CONTEXT);
  const t0 = Date.now();
  runPokerSelfPlayToEnd(tunnel, botA, botB, handCap * 200);
  return { transcript, tunnel, playMs: Date.now() - t0 };
}

async function uploadToWalrus(body: string): Promise<{ ms: number; ok: boolean; note: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${PUBLISHER}/v1/blobs?epochs=1`, { method: "PUT", body });
    const ms = Date.now() - t0;
    const text = await res.text();
    if (!res.ok) return { ms, ok: false, note: `HTTP ${res.status}` };
    return { ms, ok: true, note: "ok" };
  } catch (e) {
    return { ms: Date.now() - t0, ok: false, note: e instanceof Error ? e.message : String(e) };
  }
}

interface Row {
  cap: number;
  hands: number;
  entries: number;
  mb: number;
  playMs: number;
  upMs: number;
  ok: boolean;
  note: string;
}

async function main() {
  process.stderr.write(`publisher: ${PUBLISHER}\ncaps: ${SWEEP.join(", ")}\n`);
  const rows: Row[] = [];
  for (const cap of SWEEP) {
    const { transcript, tunnel, playMs } = playTunnel(cap);
    const hands = Number((tunnel.state as PokerState).handNo);
    const record = transcript.toRecord();
    const entries = record.entries.length;
    const json = JSON.stringify(record);
    const mb = Buffer.byteLength(json) / (1024 * 1024);
    const up = await uploadToWalrus(json);
    rows.push({ cap, hands, entries, mb, playMs, upMs: up.ms, ok: up.ok, note: up.note });
    process.stderr.write(
      `  cap=${cap}: ${entries} entries, ${f(mb, 1)}MB, play ${f(playMs / 1000, 1)}s, ` +
        `settle ${f(up.ms / 1000, 1)}s ${up.ok ? "" : "FAIL " + up.note}\n`,
    );
  }

  // ---- Markdown report table (stdout, so `> bench.md` captures just this) ----
  const head = [
    "hand_cap", "hands", "entries", "sizeMB", "playS", "settleS", "totalS",
    "TPS", "TPS_raw", "settle ms/hand", "settle s/MB", "MB/s",
  ];
  console.log(`# Quantum Poker settle benchmark — ${PUBLISHER}`);
  console.log(`\n| ${head.join(" | ")} |`);
  console.log(`|${head.map(() => "---:").join("|")}|`);
  for (const r of rows) {
    const playS = r.playMs / 1000;
    const settleS = r.upMs / 1000;
    const totalS = playS + settleS;
    const tps = r.ok && totalS > 0 ? Math.round(r.entries / totalS) : 0;
    const tpsRaw = playS > 0 ? Math.round(r.entries / playS) : 0;
    const cells = [
      r.cap, r.hands, r.entries, f(r.mb), f(playS, 1), f(settleS, 1), f(totalS, 1),
      r.ok ? tps : "FAIL", tpsRaw,
      r.hands > 0 ? f(r.upMs / r.hands, 1) : "-",
      r.mb > 0 ? f(settleS / r.mb, 2) : "-",
      r.upMs > 0 ? f(r.mb / settleS, 2) : "-",
    ];
    console.log(`| ${cells.join(" | ")} |`);
  }

  // ---- Correlations / fit ----
  const ok = rows.filter((r) => r.ok && r.mb > 0 && r.upMs > 0);
  if (ok.length >= 2) {
    const n = ok.length;
    const sx = ok.reduce((s, r) => s + r.mb, 0);
    const sy = ok.reduce((s, r) => s + r.upMs, 0);
    const sxx = ok.reduce((s, r) => s + r.mb * r.mb, 0);
    const sxy = ok.reduce((s, r) => s + r.mb * r.upMs, 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx); // ms / MB
    const floor = (sy - slope * sx) / n; // ms
    const mbPerHand = ok.reduce((s, r) => s + r.mb / Math.max(1, r.hands), 0) / n;
    const entriesPerHand = ok.reduce((s, r) => s + r.entries / Math.max(1, r.hands), 0) / n;
    const playMsPerHand = ok.reduce((s, r) => s + r.playMs / Math.max(1, r.hands), 0) / n;
    const settleMsPerHand = slope * mbPerHand;
    const balanceMb = floor / slope;
    const balanceCap = Math.round(balanceMb / mbPerHand);
    const tpsRawCeil = Math.round((1000 * entriesPerHand) / playMsPerHand);
    const tpsSeqCeil = Math.round((1000 * entriesPerHand) / (playMsPerHand + settleMsPerHand));
    console.log(`\n## Correlations (fit over ${n} points)`);
    console.log(`- **size** ≈ ${f(mbPerHand * 1024, 1)} KB/hand  ·  ${f(entriesPerHand, 1)} entries(tx)/hand`);
    console.log(`- **play** ≈ ${f(playMsPerHand, 2)} ms/hand (off-chain compute)`);
    console.log(`- **settle upload** ≈ ${f(floor / 1000, 1)}s fixed + ${f(slope / 1000, 3)}s/MB  (= ${f(settleMsPerHand, 2)} ms/hand marginal)`);
    console.log(`- **size sweet spot** (fixed == transfer): ~${f(balanceMb, 1)} MB ≈ **~${balanceCap} hands/tunnel**`);
    console.log(`- **TPS ceiling**: sequential ~${tpsSeqCeil} (cap→∞, settle blocks) · pipelined ~${tpsRawCeil} (settle off the loop)`);
  }
}

void main();
