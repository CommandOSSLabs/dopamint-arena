// Headless relay-WS seat client for the tunnel-manager `/v1/mp` lane.
//
// A faithful port of tools/loadbench/src/channels/{relayChannel,relayEnvelope}.ts into the
// e2e harness so the e2e package stays decoupled from the loadbench (bun) tool while testing
// the SAME wire protocol — owned by the Rust relay (backend/tunnel-manager/src/mp/ws.rs):
// challenge -> connect (ed25519-sign the nonce) + queue.join -> match.found -> opaque `relay`
// frames. The frame<->payload codec reuses the SDK's `wrapInnerFrameJson` so the bytes on the
// wire are byte-identical to production; the relay only reads the opaque envelope, never the move.
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transport } from 'sui-tunnel-ts/core/distributedTunnel';
import { wrapInnerFrameJson } from 'sui-tunnel-ts/core/distributedFrame';

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Engine frame bytes -> the relay `payload` string `{t:"frame",kind,data}`. */
function framePayload(frameBytes: Uint8Array): string {
  return wrapInnerFrameJson(new TextDecoder().decode(frameBytes));
}

/** Relay `payload` -> engine frame bytes, or null for a non-frame peer message.
 *  The relay forwards opaque payloads verbatim, so non-frame messages are expected
 *  and must not throw. */
function payloadFrame(payload: string): Uint8Array | null {
  let env: unknown;
  try {
    env = JSON.parse(payload);
  } catch {
    return null;
  }
  if (env === null || typeof env !== 'object') return null;
  const e = env as { t?: unknown; data?: unknown };
  if (e.t !== 'frame' || typeof e.data !== 'string') return null;
  return new TextEncoder().encode(e.data);
}

export interface RelaySeat {
  transport: Transport;
  matchId: string;
  role: 'A' | 'B';
  close(): void;
}

/** Connect one WS seat to the relay and resolve once it is paired (`match.found`).
 *  Two seats that `queue.join` the same `game` token are matched to each other. The
 *  returned `transport` is fed straight into a `DistributedTunnel`. */
export function connectRelaySeat(opts: {
  url: string;
  game: string;
  keypair: Ed25519Keypair;
  WebSocketCtor?: typeof WebSocket;
}): Promise<RelaySeat> {
  const WS = opts.WebSocketCtor ?? globalThis.WebSocket;
  const wallet = opts.keypair.getPublicKey().toSuiAddress();
  const pubkey = toHex(opts.keypair.getPublicKey().toRawBytes());
  const ws = new WS(opts.url) as WebSocket;
  let frameCb: ((f: Uint8Array) => void) | null = null;
  let matchId = '';

  const transport: Transport = {
    send: (f) => ws.send(JSON.stringify({ type: 'relay', matchId, payload: framePayload(f) })),
    onFrame: (cb) => {
      frameCb = cb;
    },
  };

  return new Promise<RelaySeat>((resolve, reject) => {
    ws.onerror = () => reject(new Error('relay socket error'));
    ws.onmessage = async (ev: MessageEvent) => {
      let m: { type?: string; nonce?: string; matchId?: string; role?: 'A' | 'B'; payload?: string };
      try {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
        m = JSON.parse(raw) as typeof m;
      } catch {
        return;
      }
      if (m.type === 'challenge') {
        const sig = toHex(await opts.keypair.sign(new TextEncoder().encode(m.nonce)));
        ws.send(JSON.stringify({ type: 'connect', wallet, pubkey, sig, nonce: m.nonce }));
        ws.send(JSON.stringify({ type: 'queue.join', game: opts.game }));
      } else if (m.type === 'match.found' && m.matchId && m.role) {
        matchId = m.matchId;
        resolve({ transport, matchId, role: m.role, close: () => ws.close() });
      } else if (m.type === 'relay' && m.matchId === matchId && typeof m.payload === 'string') {
        const bytes = payloadFrame(m.payload);
        if (bytes) frameCb?.(bytes);
      }
    };
  });
}
