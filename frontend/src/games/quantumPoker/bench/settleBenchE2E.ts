// End-to-end settle benchmark through the LOCAL tunnel-manager: for each hand cap it opens a REAL
// on-chain tunnel (create_and_fund, funded by the settler account), plays it off-chain, then POSTs
// /settle to the local backend, which submits the cooperative close on-chain AND archives the
// transcript to Walrus. Measures the full real-world settle latency (open + close + Walrus).
//
// Prereqs: local backend running on $BACKEND (default http://localhost:8080) with the 64MB body
// limit, and backend/tunnel-manager/.env holding SUI_SETTLER_KEY + SUI_RPC_URL (the settler must
// hold testnet SUI — it funds the opens and sponsors the closes).
//
// Run (from frontend/):
//   node --import tsx src/games/quantumPoker/bench/settleBenchE2E.ts 50 200 800
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
const SWEEP = ARGV.length > 0 ? ARGV : [50, 200, 800];

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
      process.stderr.write(`\nsettle error (HTTP ${res.status}): ${text}\n`);
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

async function main() {
  const settler = Ed25519Keypair.fromSecretKey(fromBase64(readEnv("SUI_SETTLER_KEY")));
  const rpc = readEnv("SUI_RPC_URL");
  const client = new SuiJsonRpcClient({ url: rpc });
  const reads = client as unknown as SuiReads;
  const signExec: SignExec = async (tx) => {
    const r = await client.signAndExecuteTransaction({
      signer: settler,
      transaction: tx as never,
      options: { showEffects: true },
    });
    await client.waitForTransaction({ digest: r.digest });
    return { digest: r.digest };
  };

  const addr = settler.getPublicKey().toSuiAddress();
  const bal = await client.getBalance({ owner: addr });
  process.stderr.write(
    `backend: ${BACKEND}\nrpc: ${rpc}\nsettler: ${addr}  balance: ${(Number(bal.totalBalance) / 1e9).toFixed(3)} SUI\ncaps: ${SWEEP.join(", ")}\n`,
  );
  if (BigInt(bal.totalBalance) < 50_000_000n) {
    process.stderr.write("⚠️  settler balance < 0.05 SUI — opens/closes may fail (faucet it)\n");
  }

  const head = ["hand_cap", "hands", "entries", "sizeMB", "openS", "playS", "settleS", "totalS", "TPS", "result"];
  console.log(`# Quantum Poker END-TO-END settle benchmark (local backend)`);
  console.log(`\n| ${head.join(" | ")} |`);
  console.log(`|${head.map(() => "---:").join("|")}|`);

  for (const cap of SWEEP) {
    try {
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
      const openS = (Date.now() - t0) / 1000;
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
      const playS = (Date.now() - p0) / 1000;

      const state = tunnel.state as PokerState;
      const record = transcript.toRecord();
      const mb = Buffer.byteLength(JSON.stringify(record)) / (1024 * 1024);
      const settlement = tunnel.buildSettlementWithRoot(createdAt, transcript.root(), 0n);
      const reqBody = coSignedToSettleRequest(
        settlement as unknown as Parameters<typeof coSignedToSettleRequest>[0],
        record.entries,
      );
      const settle = await settleViaBackend(tunnelId, reqBody);

      const totalS = openS + playS + settle.ms / 1000; // full tunnel lifecycle
      const tps = settle.ok && totalS > 0 ? Math.round(record.entries.length / totalS) : 0;
      const cells = [
        cap, Number(state.handNo), record.entries.length, f(mb),
        f(openS, 1), f(playS, 1), f(settle.ms / 1000, 1), f(totalS, 1),
        settle.ok ? tps : "FAIL", settle.ok ? settle.note : settle.note,
      ];
      console.log(`| ${cells.join(" | ")} |`);
    } catch (e) {
      console.log(`| ${cap} | — | — | — | — | — | — | FAIL | ${e instanceof Error ? e.message.slice(0, 80) : String(e)} |`);
    }
  }
}

void main();
