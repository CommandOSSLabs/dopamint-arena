import type { Transport } from "../../../../sui-tunnel-ts/src/core/distributedTunnel";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { framePayload, payloadFrame } from "./relayEnvelope";

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export interface RelaySeat { transport: Transport; matchId: string; role: "A" | "B"; close(): void }

export function connectRelaySeat(opts: {
  url: string; game: string; keypair: Ed25519Keypair; WebSocketCtor?: typeof WebSocket;
}): Promise<RelaySeat> {
  const WS = opts.WebSocketCtor ?? globalThis.WebSocket;
  const wallet = opts.keypair.getPublicKey().toSuiAddress();
  const pubkey = toHex(opts.keypair.getPublicKey().toRawBytes());
  const ws: any = new WS(opts.url);
  let frameCb: ((f: Uint8Array) => void) | null = null;
  let matchId = "";

  const transport: Transport = {
    send: (f) => ws.send(JSON.stringify({ type: "relay", matchId, payload: framePayload(f) })),
    onFrame: (cb) => { frameCb = cb; },
  };

  return new Promise<RelaySeat>((resolve, reject) => {
    ws.onerror = () => reject(new Error("relay socket error"));
    ws.onmessage = async (ev: { data: string }) => {
      let m: { type?: string; nonce?: string; matchId?: string; role?: "A" | "B"; payload?: string };
      try {
        const raw = typeof ev.data === "string" ? ev.data : (ev.data as { toString(): string }).toString();
        m = JSON.parse(raw) as typeof m;
      } catch {
        process.stderr.write(`[relayChannel] malformed control frame dropped: ${String(ev.data).slice(0, 120)}\n`);
        return;
      }
      if (m.type === "challenge") {
        const sig = toHex(await opts.keypair.sign(new TextEncoder().encode(m.nonce)));
        ws.send(JSON.stringify({ type: "connect", wallet, pubkey, sig, nonce: m.nonce }));
        ws.send(JSON.stringify({ type: "queue.join", game: opts.game }));
      } else if (m.type === "match.found" && m.matchId && m.role) {
        matchId = m.matchId;
        resolve({ transport, matchId, role: m.role, close: () => ws.close() });
      } else if (m.type === "relay" && m.matchId === matchId && typeof m.payload === "string") {
        const bytes = payloadFrame(m.payload);
        if (bytes) frameCb?.(bytes);
      }
    };
  });
}
