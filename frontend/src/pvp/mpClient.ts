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
  | { t: "endMatch" }
  | {
      t: "settleHalf";
      partyABalance: string;
      partyBBalance: string;
      finalNonce: string;
      timestamp: string;
      transcriptRoot: string;
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
  #connected = false;
  #intentionalClose = false;

  /** Fires when the socket closes UNEXPECTEDLY (relay/connection drop), not on our own
   *  close(). The relay has no rejoin-by-matchId, so a mid-match drop can't be resumed —
   *  consumers use this only to surface a clear "connection lost" state instead of a stall. */
  onClose: (() => void) | null = null;

  // Multiplexing (spec decision #6): route inbound relay frames by matchId, and hand each
  // match.found to the next waiting quickMatch (FIFO). This lets ONE socket run MANY concurrent
  // tunnels — the single-match path is just the degenerate case (one handler, one waiter).
  readonly #relayHandlers = new Map<string, (payload: string) => void>();
  #matchQueue: MatchInfo[] = [];
  #matchWaiters: {
    resolve: (m: MatchInfo) => void;
    reject: (e: Error) => void;
  }[] = [];

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
          this.#connected = true;
          resolve();
        } else if (m.type === "match.found") {
          this.#deliverMatch({
            matchId: m.matchId as string,
            role: m.role as Role,
            opponentWallet: m.opponentWallet as string,
            game: m.game as string,
          });
        } else if (m.type === "relay") {
          this.#relayHandlers.get(m.matchId as string)?.(m.payload as string);
        } else if (m.type === "queue.timeout") {
          this.#failNextMatch(new Error("queue.timeout"));
        } else if (m.type === "error") {
          if (!this.#connected) reject(new Error(`mp ${m.code}: ${m.message}`));
          else this.#failNextMatch(new Error(`mp ${m.code}: ${m.message}`));
        }
      };
      ws.onerror = () => {
        if (!this.#connected) reject(new Error("mp websocket error"));
      };
      ws.onclose = () => {
        this.#ws = null;
        if (this.#connected && !this.#intentionalClose) this.onClose?.();
      };
    });
  }

  #deliverMatch(m: MatchInfo) {
    const w = this.#matchWaiters.shift();
    if (w) w.resolve(m);
    else this.#matchQueue.push(m); // arrived before a waiter; next quickMatch claims it
  }
  #failNextMatch(e: Error) {
    this.#matchWaiters.shift()?.reject(e);
  }

  /** Join a per-game queue; resolves when paired. Safe to call CONCURRENTLY (FIFO-matched) —
   *  this is what lets one agent run many tunnels over one socket. */
  quickMatch(game: string): Promise<MatchInfo> {
    this.#send({ type: "queue.join", game });
    const buffered = this.#matchQueue.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) =>
      this.#matchWaiters.push({ resolve, reject }),
    );
  }

  /** Build the engine transport + peer side-channel for a paired match; inbound frames route
   *  by matchId so concurrent matches never clobber each other. */
  channel(matchId: string): PvpChannel {
    let engineOnFrame: ((bytes: Uint8Array) => void) | null = null;
    let peerCb: ((msg: Exclude<PeerMessage, { t: "frame" }>) => void) | null =
      null;
    this.#relayHandlers.set(matchId, (payload) => {
      const o = JSON.parse(payload) as PeerMessage;
      if (o.t === "frame") engineOnFrame?.(te.encode(o.data));
      else peerCb?.(o);
    });
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

  /** Stop routing frames for a finished match (free its handler). */
  releaseMatch(matchId: string) {
    this.#relayHandlers.delete(matchId);
  }

  /** Announce the opened on-chain tunnel id to the backend registry (watchtower). */
  announceTunnel(matchId: string, tunnelId: string) {
    this.#send({ type: "tunnel.opened", matchId, tunnelId });
  }

  close() {
    this.#intentionalClose = true;
    this.#ws?.close();
    this.#ws = null;
  }

  #send(obj: unknown) {
    this.#ws?.send(JSON.stringify(obj));
  }
}
