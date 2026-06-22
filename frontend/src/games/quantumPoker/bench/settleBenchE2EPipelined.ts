// PIPELINED end-to-end settle benchmark. Opens + plays each tunnel SEQUENTIALLY (one settler gas
// coin, one JS thread), but fires /settle in the BACKGROUND with a concurrency cap D and starts the
// next open+play immediately — so each tunnel's slow close+Walrus overlaps the next tunnel's play.
// Measures the real pipelined throughput (entries / open+play wall, settle hidden) vs the sequential
// baseline, and verifies that D concurrent SIP-58 closes succeed (no shared gas coin → no
// equivocation; ADR-0005). This is the proof-of-value before refactoring useQuantumPokerAuto.
//
// Run (from frontend/), needs the local backend up + settler address-balance funded:
//   node --import tsx src/games/quantumPoker/bench/settleBenchE2EPipelined.ts            # cap=800 N=8 D=3
//   node --import tsx src/games/quantumPoker/bench/settleBenchE2EPipelined.ts 200 12 4   # cap N D
import "./benchEnv"; // MUST be first: sets PACKAGE_ID/SUI_NETWORK before the SDK config loads.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import {
  QuantumPokerProtocol,
  type PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import {
  openAndFundSelfPlayReturnless,
  readCreatedAt,
  type SignExec,
  type SuiReads,
} from "@/onchain/tunnelTx";
import { coSignedToSettleRequest } from "@/backend/settleRequest";
import {
  makeSeatBot,
  runPokerSelfPlayToEnd,
  LIVE_BOT_CONTEXT,
  type PokerTunnel,
} from "../pokerSelfPlay";

const BACKEND = (process.env.BACKEND ?? "http://localhost:8080").replace(/\/$/, "");
const STAKE = 10_000n;
const ARGV = process.argv.slice(2).map(Number).filter((n) => n > 0);
const CAP = ARGV[0] ?? 800; // hands per tunnel
const N = ARGV[1] ?? 8; // number of tunnels in the run
const D = ARGV[2] ?? 3; // max settles in flight (pipeline depth)

const f = (n: number, d = 2): string => n.toFixed(d);

/** Read a var from backend/tunnel-manager/.env (relative to this file). */
function readEnv(name: string): string {
  const envPath = fileURLToPath(
    new URL("../../../../../backend/tunnel-manager/.env", import.meta.url),
  );
  const line = readFileSync(envPath, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} not found in ${envPath}`);
  return line.slice(name.length + 1).trim();
}

async function settleViaBackend(
  tunnelId: string,
  body: unknown,
): Promise<{ ms: number; ok: boolean; note: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BACKEND}/v1/tunnels/${tunnelId}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    if (!res.ok) {
      process.stderr.write(`\nsettle error (HTTP ${res.status}): ${text.slice(0, 200)}\n`);
      return { ms, ok: false, note: `HTTP ${res.status}` };
    }
    let note = "ok";
    try {
      const j = JSON.parse(text);
      note = j?.proofUrl ? "walrus ✓" : j?.txDigest ? "closed" : "ok";
    } catch {
      /* ignore */
    }
    return { ms, ok: true, note };
  } catch (e) {
    return { ms: Date.now() - t0, ok: false, note: e instanceof Error ? e.message : String(e) };
  }
}

interface OpenPlayResult {
  tunnelId: string;
  reqBody: unknown;
  entries: number;
  hands: number;
  mb: number;
  openMs: number;
  playMs: number;
}

/** Open a real tunnel (settler gas coin), play it off-chain, build the settle body. Sequential. */
async function openAndPlay(
  reads: SuiReads,
  signExec: SignExec,
  cap: number,
): Promise<OpenPlayResult> {
  const a = createParticipant("bench-A");
  const b = createParticipant("bench-B");
  const t0 = Date.now();
  const tunnelId = await openAndFundSelfPlayReturnless({
    reads,
    signExec,
    partyA: { address: a.address, publicKey: a.keyPair.publicKey },
    partyB: { address: b.address, publicKey: b.keyPair.publicKey },
    aAmount: STAKE,
    bAmount: STAKE,
  });
  const openMs = Date.now() - t0;
  const createdAt = await readCreatedAt(reads, tunnelId);

  const protocol = new QuantumPokerProtocol(BigInt(cap));
  const tunnel = OffchainTunnel.selfPlay(
    protocol, tunnelId, a.keyPair, b.keyPair, a.address, b.address,
    { a: STAKE, b: STAKE },
  ) as PokerTunnel;
  const transcript = new Transcript(tunnelId);
  tunnel.onUpdate = (u) => transcript.append(u);
  const botA = makeSeatBot("A", STAKE, BigInt(cap), { name: "Nari", persona: "tight" }, LIVE_BOT_CONTEXT);
  const botB = makeSeatBot("B", STAKE, BigInt(cap), { name: "Jules", persona: "loose" }, LIVE_BOT_CONTEXT);
  const p0 = Date.now();
  runPokerSelfPlayToEnd(tunnel, botA, botB, cap * 200);
  const playMs = Date.now() - p0;

  const record = transcript.toRecord();
  const mb = Buffer.byteLength(JSON.stringify(record)) / (1024 * 1024);
  const settlement = tunnel.buildSettlementWithRoot(createdAt, transcript.root(), 0n);
  const reqBody = coSignedToSettleRequest(
    settlement as unknown as Parameters<typeof coSignedToSettleRequest>[0],
    record.entries,
  );
  return {
    tunnelId, reqBody,
    entries: record.entries.length,
    hands: Number((tunnel.state as PokerState).handNo),
    mb, openMs, playMs,
  };
}

async function main() {
  const settler = Ed25519Keypair.fromSecretKey(fromBase64(readEnv("SUI_SETTLER_KEY")));
  // Opens are signed by a SEPARATE account (like the app: bot A opens, settler closes) so opens
  // don't contend with closes on the settler's address balance — isolating the close-vs-close case.
  const opener = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7));
  const rpc = readEnv("SUI_RPC_URL");
  const client = new SuiJsonRpcClient({ url: rpc });
  const reads = client as unknown as SuiReads;
  const signExec: SignExec = async (tx) => {
    const r = await client.signAndExecuteTransaction({
      signer: opener,
      transaction: tx as never,
      options: { showEffects: true },
    });
    await client.waitForTransaction({ digest: r.digest });
    return { digest: r.digest };
  };

  const addr = settler.getPublicKey().toSuiAddress();
  const openerAddr = opener.getPublicKey().toSuiAddress();
  const [bal, obal] = await Promise.all([
    client.getBalance({ owner: addr }),
    client.getBalance({ owner: openerAddr }),
  ]);
  process.stderr.write(
    `backend: ${BACKEND}\nrpc: ${rpc}\n` +
      `settler (closes): ${addr}  ${(Number(bal.totalBalance) / 1e9).toFixed(3)} SUI\n` +
      `opener  (opens):  ${openerAddr}  ${(Number(obal.totalBalance) / 1e9).toFixed(3)} SUI\n` +
      `config: cap=${CAP}  tunnels=${N}  depth D=${D}\n\n`,
  );

  // ---- Pipelined run: open+play sequential, settle backgrounded with cap D. ----
  const inflight = new Set<Promise<void>>();
  const settleMs: number[] = [];
  const openMsArr: number[] = [];
  const playMsArr: number[] = [];
  let entriesTotal = 0;
  let handsTotal = 0;
  let mbTotal = 0;
  let okCloses = 0;
  let walrusCloses = 0;
  let live = 0;
  let maxLive = 0;

  const tStart = Date.now();
  for (let i = 0; i < N; i++) {
    if (inflight.size >= D) await Promise.race(inflight);
    const op = await openAndPlay(reads, signExec, CAP);
    openMsArr.push(op.openMs);
    playMsArr.push(op.playMs);
    entriesTotal += op.entries;
    handsTotal += op.hands;
    mbTotal += op.mb;
    live += 1;
    maxLive = Math.max(maxLive, live);
    const idx = i;
    const firedAt = Date.now();
    const p: Promise<void> = settleViaBackend(op.tunnelId, op.reqBody)
      .then((s) => {
        settleMs.push(s.ms);
        if (s.ok) okCloses += 1;
        if (s.note === "walrus ✓") walrusCloses += 1;
        process.stderr.write(
          `  tunnel ${idx}: open ${f(op.openMs / 1000, 1)}s play ${f(op.playMs / 1000, 1)}s ` +
            `settle ${f(s.ms / 1000, 1)}s (live=${live}) ${s.ok ? s.note : "FAIL " + s.note}\n`,
        );
      })
      .catch((e) => {
        process.stderr.write(`  tunnel ${idx}: settle threw ${String(e).slice(0, 80)}\n`);
      })
      .finally(() => {
        live -= 1;
        inflight.delete(p);
      });
    inflight.add(p);
    void firedAt;
  }
  const loopWallMs = Date.now() - tStart; // all opens+plays done (settles may still be flying)
  await Promise.allSettled(inflight);
  const totalWallMs = Date.now() - tStart; // includes draining the last D settles

  // ---- Derived metrics ----
  const sum = (a: number[]) => a.reduce((s, n) => s + n, 0);
  const avg = (a: number[]) => (a.length ? sum(a) / a.length : 0);
  const openPlayWallS = sum(openMsArr.concat([])) / 1000 + sum(playMsArr) / 1000; // sequential part
  const tpsPipeSteady = openPlayWallS > 0 ? Math.round(entriesTotal / openPlayWallS) : 0; // settle hidden
  const tpsPipeTotal = totalWallMs > 0 ? Math.round(entriesTotal / (totalWallMs / 1000)) : 0; // incl tail
  // Sequential baseline from the SAME measured timings: open+play+settle per tunnel, summed.
  const seqWallS = (sum(openMsArr) + sum(playMsArr) + sum(settleMs)) / 1000;
  const tpsSeq = seqWallS > 0 ? Math.round(entriesTotal / seqWallS) : 0;

  const head = ["metric", "value"];
  console.log(`# Quantum Poker PIPELINED settle benchmark (local backend)`);
  console.log(`\n| ${head.join(" | ")} |`);
  console.log(`|---|---:|`);
  const rows: [string, string | number][] = [
    ["cap / tunnels / depth", `${CAP} / ${N} / ${D}`],
    ["total hands", handsTotal],
    ["total entries", entriesTotal],
    ["total transcript MB", f(mbTotal, 1)],
    ["avg open / play / settle (s)", `${f(avg(openMsArr) / 1000, 1)} / ${f(avg(playMsArr) / 1000, 1)} / ${f(avg(settleMs) / 1000, 1)}`],
    ["loop wall — open+play, settle hidden (s)", f(loopWallMs / 1000, 1)],
    ["total wall — incl tail drain (s)", f(totalWallMs / 1000, 1)],
    ["**TPS pipelined (steady, settle hidden)**", tpsPipeSteady],
    ["TPS pipelined (total, incl tail)", tpsPipeTotal],
    ["TPS sequential baseline (same timings)", tpsSeq],
    ["speedup (pipe steady / sequential)", `${f(tpsPipeSteady / Math.max(1, tpsSeq), 2)}×`],
    ["— SAFETY —", ""],
    ["closes OK", `${okCloses}/${N}`],
    ["walrus proofs", `${walrusCloses}/${N}`],
    ["max concurrent settles observed", maxLive],
  ];
  for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
}

void main();
