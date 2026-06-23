import { core, bytesToHex } from "sui-tunnel-ts";

type Json = Record<string, unknown>;
export interface MatchInfo {
  matchId: string;
  role: "A" | "B";
  opponentWallet: string;
  game: string;
}
export interface RelayTransport {
  send: (frame: Uint8Array) => void;
  onFrame: (cb: (f: Uint8Array) => void) => void;
}

const dec = new TextDecoder();
const enc = new TextEncoder();

/** One authenticated relay connection for a player.
 * @deprecated Superseded by MpClient (frontend/src/pvp/mpClient.ts); retained for reference. */
export class RelayClient {
  private ws: WebSocket;
  private nonce = "";
  private handlers: Record<string, ((m: Json) => void)[]> = {};
  private frameCbs: Record<string, (f: Uint8Array) => void> = {}; // matchId -> engine onFrame
  private appCbs: Record<string, (m: Json) => void> = {}; // matchId -> app msg handler
  ready: Promise<void>;

  constructor(
    private url: string,
    private walletAddress: string,
    private eph: ReturnType<typeof core.keyPairFromSecret>,
  ) {
    this.ws = new WebSocket(`${url.replace(/\/$/, "")}/v1/mp`);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("error", () =>
        reject(new Error("relay ws error")),
      );
      this.ws.addEventListener("message", (ev) =>
        this.onMessage(String(ev.data), resolve),
      );
    });
  }

  private onMessage(text: string, onConnected: () => void) {
    let m: Json;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    switch (m.type) {
      case "challenge": {
        this.nonce = String(m.nonce);
        const sig = core.sign(enc.encode(this.nonce), this.eph.secretKey);
        this.send({
          type: "connect",
          wallet: this.walletAddress,
          pubkey: bytesToHex(this.eph.publicKey),
          sig: bytesToHex(sig),
          nonce: this.nonce,
        });
        onConnected(); // presence is set server-side on connect; no explicit ack
        break;
      }
      case "relay": {
        const matchId = String(m.matchId);
        let env: Json;
        try {
          env = JSON.parse(String(m.payload));
        } catch {
          return;
        }
        if (env.t === "frame")
          this.frameCbs[matchId]?.(enc.encode(String(env.f)));
        else this.appCbs[matchId]?.(env);
        break;
      }
      default:
        (this.handlers[String(m.type)] ?? []).forEach((h) => h(m));
    }
  }

  private send(o: Json) {
    this.ws.send(JSON.stringify(o));
  }
  on(type: string, cb: (m: Json) => void) {
    (this.handlers[type] ??= []).push(cb);
  }

  queueJoin(game: string) {
    this.send({ type: "queue.join", game });
  }
  partyHello(matchId: string, ephemeralPubkey: string, walletSig: string) {
    this.send({ type: "party.hello", matchId, ephemeralPubkey, walletSig });
  }
  tunnelOpened(matchId: string, tunnelId: string) {
    this.send({ type: "tunnel.opened", matchId, tunnelId });
  }

  /** App-level message to the other seat (settlement half, closed digest, …). */
  sendApp(matchId: string, msg: Json) {
    this.send({ type: "relay", matchId, payload: JSON.stringify({ ...msg }) });
  }
  onApp(matchId: string, cb: (m: Json) => void) {
    this.appCbs[matchId] = cb;
  }

  /** Engine transport for one match: engine frames travel as `{t:"frame", f}` relay payloads. */
  transport(matchId: string): RelayTransport {
    return {
      send: (frame) =>
        this.send({
          type: "relay",
          matchId,
          payload: JSON.stringify({ t: "frame", f: dec.decode(frame) }),
        }),
      onFrame: (cb) => {
        this.frameCbs[matchId] = cb;
      },
    };
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
