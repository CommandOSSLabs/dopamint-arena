import { generateKeyPair, sign, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { toHex } from "sui-tunnel-ts/core/bytes";
import type { Transport } from "sui-tunnel-ts/core/distributedTunnel";
import { wrapInnerFrameJson } from "sui-tunnel-ts/core/distributedFrame";
import WebSocket from "ws";

export type Role = "A" | "B";

export interface MatchInfo {
  matchId: string;
  role: Role;
  opponentWallet: string;
  game: string;
}

export type PeerMessage =
  | { t: "hello"; ephemeralPubkey: string }
  | { t: "opened"; tunnelId: string }
  | { t: "settle"; sig: string; root: string }
  | { t: "closed"; digest: string }
  | { t: "stop" };

export interface MpChannel {
  transport: Transport;
  sendPeer(msg: PeerMessage): void;
  onPeer(cb: (msg: PeerMessage) => void): void;
}

export function resolveMpWsUrl(backendUrl: string): string {
  return backendUrl.replace(/^http/, "ws").replace(/\/+$/, "");
}

export class MpClient {
  private url: string;
  private wallet: string;
  private ws: WebSocket | null = null;
  private ephemeral: KeyPair;
  private sign: (msg: Uint8Array) => Uint8Array;
  private matchWaiters: {
    resolve: (m: MatchInfo) => void;
    reject: (e: Error) => void;
  }[] = [];
  private relayHandlers = new Map<string, (payload: string) => void>();

  constructor(url: string, wallet: string) {
    this.url = url;
    this.wallet = wallet;
    this.ephemeral = generateKeyPair();
    this.sign = (msg) => sign(msg, this.ephemeral.secretKey);
  }

  publicKeyHex(): string {
    return toHex(this.ephemeral.publicKey);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on("open", () => {});
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString());
        if (m.type === "challenge") {
          const sig = this.sign(new TextEncoder().encode(m.nonce));
          ws.send(
            JSON.stringify({
              type: "connect",
              wallet: this.wallet,
              pubkey: toHex(this.ephemeral.publicKey),
              sig: toHex(sig),
              nonce: m.nonce,
            }),
          );
          resolve();
        } else if (m.type === "match.found") {
          const info: MatchInfo = {
            matchId: m.matchId,
            role: m.role,
            opponentWallet: m.opponentWallet,
            game: m.game,
          };
          const w = this.matchWaiters.shift();
          if (w) w.resolve(info);
        } else if (m.type === "relay") {
          this.relayHandlers.get(m.matchId)?.(m.payload);
        } else if (m.type === "error") {
          const w = this.matchWaiters.shift();
          if (w) w.reject(new Error(`${m.code}: ${m.message}`));
        }
      });
      ws.on("error", (e) => reject(e));
    });
  }

  quickMatch(game: string): Promise<MatchInfo> {
    this.send({ type: "queue.join", game });
    return new Promise((resolve, reject) => {
      this.matchWaiters.push({ resolve, reject });
    });
  }

  channel(matchId: string): MpChannel {
    const peerCbs = new Set<(msg: PeerMessage) => void>();
    const frameBuffer: Uint8Array[] = [];
    let engineOnFrame: ((bytes: Uint8Array) => void) | null = null;

    this.relayHandlers.set(matchId, (payload) => {
      const o = JSON.parse(payload) as
        | PeerMessage
        | { t: "frame"; data: string };
      if (o.t === "frame") {
        const bytes = new TextEncoder().encode(o.data);
        if (engineOnFrame) engineOnFrame(bytes);
        else frameBuffer.push(bytes);
      } else {
        peerCbs.forEach((cb) => cb(o));
      }
    });

    const relaySend = (obj: PeerMessage) =>
      this.send({ type: "relay", matchId, payload: JSON.stringify(obj) });

    return {
      transport: {
        send: (bytes: Uint8Array) => {
          const innerJson = new TextDecoder().decode(bytes);
          this.send({
            type: "relay",
            matchId,
            payload: wrapInnerFrameJson(innerJson),
          });
        },
        onFrame: (cb: (frame: Uint8Array) => void) => {
          engineOnFrame = cb;
          if (frameBuffer.length) {
            const pending = frameBuffer.splice(0);
            for (const b of pending) cb(b);
          }
        },
      },
      sendPeer: (msg) => relaySend(msg),
      onPeer: (cb) => {
        peerCbs.clear();
        peerCbs.add(cb);
      },
    };
  }

  announceTunnel(matchId: string, tunnelId: string): void {
    this.send({ type: "tunnel.opened", matchId, tunnelId });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private send(obj: unknown): void {
    this.ws?.send(JSON.stringify(obj));
  }
}
