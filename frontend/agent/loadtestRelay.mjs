// Relay frame-rate bench (spec §Numbers#1): open T pairs of raw WS clients to the relay,
// pair each pair on a dedicated game queue, then ping-pong opaque frames as fast as the relay
// forwards them. Reports forwarded-frames/sec — the number that sizes the P2 relay fleet vs
// R_min. Goes DIRECT to the ALB (not the vite proxy) to measure the relay itself.
// Auth handshake mirrors scripts/pvpTttBot.mjs. No on-chain ops — the relay forwards opaque
// frames regardless of tunnel state.
// Run: MP_WS_URL=ws://<alb>/v1/mp T=25 D=15 node agent/loadtestRelay.mjs
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const URL =
  process.env.MP_WS_URL ??
  "ws://dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com/v1/mp";
const T = Number(process.env.T ?? 25); // tunnels (pairs)
const D = Number(process.env.D ?? 15) * 1000;
const GAME = process.env.GAME ?? "loadtest"; // isolated from real agents
// Frames kept in flight per tunnel. >1 decouples throughput from RTT so the bench measures the
// relay's forward capacity, not the round-trip latency (critical when NOT co-located).
const PIPELINE = Number(process.env.PIPELINE ?? 8);

const WS = globalThis.WebSocket ?? (await import("ws")).default;
const te = new TextEncoder();
const toHex = (b) => Buffer.from(b).toString("hex");

let frames = 0;
let matched = 0;
let errors = 0;
const clients = [];

function client() {
  const kp = new Ed25519Keypair();
  const wallet = kp.getPublicKey().toSuiAddress();
  const pubkey = toHex(kp.getPublicKey().toRawBytes());
  const ws = new WS(URL);
  let matchId = null;
  ws.onmessage = async (ev) => {
    const data = typeof ev.data === "string" ? ev.data : ev.data.toString();
    const m = JSON.parse(data);
    if (m.type === "challenge") {
      const sig = toHex(await kp.sign(te.encode(m.nonce)));
      ws.send(
        JSON.stringify({
          type: "connect",
          wallet,
          pubkey,
          sig,
          nonce: m.nonce,
        }),
      );
      ws.send(JSON.stringify({ type: "queue.join", game: GAME }));
    } else if (m.type === "match.found") {
      matchId = m.matchId;
      matched++;
      // Seat A primes the pipeline; both sides reply 1-for-1, keeping ~PIPELINE frames circulating.
      if (m.role === "A")
        for (let k = 0; k < PIPELINE; k++)
          ws.send(JSON.stringify({ type: "relay", matchId, payload: "x" }));
    } else if (m.type === "relay") {
      frames++;
      ws.send(JSON.stringify({ type: "relay", matchId, payload: "x" }));
    } else if (m.type === "error") {
      errors++;
    }
  };
  ws.onerror = () => {
    errors++;
  };
  return ws;
}

for (let i = 0; i < 2 * T; i++) clients.push(client());

const start = Date.now();
setTimeout(() => {
  const secs = (Date.now() - start) / 1000;
  console.log(
    `relay: ${frames} frames in ${secs.toFixed(0)}s = ~${Math.round(frames / secs)} frames/s | matched ${matched / 2}/${T} pairs | errors ${errors}`,
  );
  for (const c of clients) {
    try {
      c.close();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}, D);
