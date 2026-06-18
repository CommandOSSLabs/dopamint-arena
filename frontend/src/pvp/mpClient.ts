// PvP control-plane client for GET /v1/mp (ADR-0004 / spec §4). Opens the WS, authenticates
// the connection by signing the server challenge with the EPHEMERAL key, runs matchmaking,
// and multiplexes two channels over the opaque relay:
//   - engine frames (MOVE/ACK) → the DistributedTunnel `Transport`
//   - peer app messages (ephemeral-key exchange, tunnel id, ready, settle halves)
// The wallet address is only a matchmaking/identity label; security rests on the co-signed
// on-chain artifacts, never on the relay.
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { toHex } from "sui-tunnel-ts/core/bytes";
import type { KeyPair } from "sui-tunnel-ts/core/crypto";
import type { Transport } from "sui-tunnel-ts/core/distributedTunnel";

export type Role = "A" | "B";

export interface MatchInfo {
  matchId: string;
  role: Role;
  opponentWallet: string;
  game: string;
}

/** A peer message tunneled through the relay (everything that isn't a MOVE/ACK frame). */
export type PeerMessage =
  | { t: "hello"; ephemeralPubkey: string }
  | { t: "open"; tunnelId: string }
  | { t: "ready" }
  | {
      t: "settleHalf";
      partyABalance: string;
      partyBBalance: string;
      finalNonce: string;
      timestamp: string;
      sig: string;
    }
  | { t: "frame"; data: string };

/** Engine transport + a peer-message side channel, both over one match's relay. */
export interface PvpChannel {
  transport: Transport;
  sendPeer(msg: Exclude<PeerMessage, { t: "frame" }>): void;
  onPeer(cb: (msg: Exclude<PeerMessage, { t: "frame" }>) => void): void;
}

const te = new TextEncoder();

/** Derive the /v1/mp WS URL from the backend base (empty => same-origin dev proxy). */
export function resolveMpWsUrl(backendUrl: string): string {
  const base =
    backendUrl || (typeof location !== "undefined" ? location.origin : "");
  return base.replace(/^http/, "ws").replace(/\/+$/, "") + "/v1/mp";
}

export class MpClient {
  #ws: WebSocket | null = null;
  readonly #url: string;
  readonly #wallet: string;
  readonly #ephemeral: KeyPair;
  readonly #sign: (msg: Uint8Array) => Uint8Array;
  #onRelay: ((payload: string) => void) | null = null;

  constructor(url: string, wallet: string, ephemeral: KeyPair) {
    this.#url = url;
    this.#wallet = wallet;
    this.#ephemeral = ephemeral;
    this.#sign = defaultBackend().makeSigner(ephemeral.secretKey!);
  }

  /** Open the socket and complete the challenge→connect handshake. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.#url);
      this.#ws = ws;
      ws.onmessage = (ev) => {
        const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        if (m.type === "challenge") {
          const sig = this.#sign(te.encode(m.nonce));
          ws.send(
            JSON.stringify({
              type: "connect",
              wallet: this.#wallet,
              pubkey: toHex(this.#ephemeral.publicKey),
              sig: toHex(sig),
              nonce: m.nonce,
            }),
          );
          resolve();
        } else if (m.type === "error") {
          reject(new Error(`mp ${m.code}: ${m.message}`));
        } else if (m.type === "relay") {
          this.#onRelay?.(m.payload);
        } else {
          this.#dispatch(m);
        }
      };
      ws.onerror = () => reject(new Error("mp websocket error"));
      ws.onclose = () => {
        this.#ws = null;
      };
    });
  }

  #serverHandlers = new Map<string, (m: Record<string, unknown>) => void>();
  #dispatch(m: Record<string, unknown>) {
    const h = this.#serverHandlers.get(m.type as string);
    if (h) h(m);
  }
  #once(type: string): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.#serverHandlers.set(type, (m) => {
        this.#serverHandlers.delete(type);
        resolve(m);
      });
    });
  }

  /** Join a per-game quick-match queue and resolve when paired. */
  async quickMatch(game: string): Promise<MatchInfo> {
    this.#send({ type: "queue.join", game });
    const m = await this.#once("match.found");
    return {
      matchId: m.matchId as string,
      role: m.role as Role,
      opponentWallet: m.opponentWallet as string,
      game: m.game as string,
    };
  }

  /** Build the engine transport + peer side-channel for a paired match. */
  channel(matchId: string): PvpChannel {
    let engineOnFrame: ((bytes: Uint8Array) => void) | null = null;
    let peerCb: ((msg: Exclude<PeerMessage, { t: "frame" }>) => void) | null =
      null;
    this.#onRelay = (payload) => {
      const o = JSON.parse(payload) as PeerMessage;
      if (o.t === "frame") engineOnFrame?.(te.encode(o.data));
      else peerCb?.(o);
    };
    const relaySend = (obj: PeerMessage) =>
      this.#send({ type: "relay", matchId, payload: JSON.stringify(obj) });
    return {
      transport: {
        send: (frame: Uint8Array) =>
          relaySend({ t: "frame", data: new TextDecoder().decode(frame) }),
        onFrame: (cb) => {
          engineOnFrame = cb;
        },
      },
      sendPeer: (msg) => relaySend(msg),
      onPeer: (cb) => {
        peerCb = cb;
      },
    };
  }

  /** Announce the opened on-chain tunnel id to the backend registry (watchtower). */
  announceTunnel(matchId: string, tunnelId: string) {
    this.#send({ type: "tunnel.opened", matchId, tunnelId });
  }

  close() {
    this.#ws?.close();
    this.#ws = null;
  }

  #send(obj: unknown) {
    this.#ws?.send(JSON.stringify(obj));
  }
}
