import { WebSocket } from "ws";
import { bytesToHex } from "@noble/hashes/utils";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Transport } from "../core/distributedTunnel";

export interface PvpClientConfig {
  url: string;
  wallet: string; // hex Sui address
  secretKey: Uint8Array;
  onMatchFound?: (
    matchId: string,
    role: "A" | "B",
    opponentWallet: string
  ) => void;
  onError?: (code: string) => void;
}

export class PvpClient {
  /**
   * Resolves after the client has received the server's `challenge` and sent
   * back a signed `connect` message (i.e., credentials submitted). It does not
   * wait for a server ack.
   */
  readonly ready: Promise<void>;

  private ws: WebSocket;
  private challengeNonce?: string;
  private matchId?: string;
  private role?: "A" | "B";
  private frameCallback?: (bytes: Uint8Array) => void;
  private outboundQueue: unknown[] = [];
  private authed = false;
  private explicitlyClosed = false;
  private textEncoder = new TextEncoder();
  private textDecoder = new TextDecoder();
  private resolveReady!: () => void;
  private rejectReady!: (reason: Error) => void;
  private readySettled = false;

  constructor(private cfg: PvpClientConfig) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ws = new WebSocket(cfg.url);
    this.ws.on("open", () => this.flushOutboundQueue());
    this.ws.on("message", (data) => this.onMessage(data.toString()));
    this.ws.on("error", (err) => {
      if (this.explicitlyClosed) return;
      this.cfg.onError?.("ws_error");
      this.rejectReadyIfPending(err);
    });
    this.ws.on("close", () => {
      if (!this.explicitlyClosed) {
        this.rejectReadyIfPending(new Error("websocket_closed_before_ready"));
      }
      this.cleanup();
    });
  }

  private markReady() {
    if (!this.readySettled) {
      this.readySettled = true;
      this.resolveReady();
    }
  }

  private rejectReadyIfPending(err: Error) {
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(err);
    }
  }

  private cleanup() {
    this.outboundQueue = [];
    this.ws.removeAllListeners();
  }

  private onMessage(text: string) {
    if (this.explicitlyClosed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.cfg.onError?.("parse_error");
      return;
    }
    if (!msg || typeof msg !== "object") {
      this.cfg.onError?.("parse_error");
      return;
    }
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case "challenge": {
        const nonce = m.nonce;
        if (typeof nonce !== "string" || nonce.length === 0) {
          this.cfg.onError?.("invalid_challenge");
          break;
        }
        this.challengeNonce = nonce;
        this.sendConnect();
        this.authed = true;
        this.markReady();
        this.flushOutboundQueue();
        break;
      }
      case "match.found": {
        const role = m.role;
        if (role !== "A" && role !== "B") {
          this.cfg.onError?.("invalid_match_role");
          break;
        }
        this.matchId = String(m.matchId);
        this.role = role;
        this.cfg.onMatchFound?.(
          String(m.matchId),
          role,
          String(m.opponentWallet)
        );
        break;
      }
      case "relay": {
        if (m.matchId !== this.matchId) {
          this.cfg.onError?.("relay_wrong_match");
          break;
        }
        let envelope: unknown;
        try {
          envelope = JSON.parse(String(m.payload));
        } catch {
          this.cfg.onError?.("parse_error");
          break;
        }
        if (!envelope || typeof envelope !== "object") {
          this.cfg.onError?.("parse_error");
          break;
        }
        const data = (envelope as Record<string, unknown>).data;
        if (this.frameCallback && typeof data === "string") {
          this.frameCallback(this.textEncoder.encode(data));
        }
        break;
      }
      case "error":
        this.cfg.onError?.(String(m.code));
        break;
      default:
        this.cfg.onError?.("unknown_message_type");
        break;
    }
  }

  private sendConnect() {
    if (this.explicitlyClosed) return;
    if (this.challengeNonce === undefined) {
      this.cfg.onError?.("missing_challenge");
      return;
    }
    const pubkey = bytesToHex(ed25519.getPublicKey(this.cfg.secretKey));
    const sig = bytesToHex(
      ed25519.sign(
        this.textEncoder.encode(this.challengeNonce),
        this.cfg.secretKey
      )
    );
    const msg = {
      type: "connect",
      wallet: this.cfg.wallet,
      pubkey,
      sig,
      nonce: this.challengeNonce,
    };
    // The server explicitly asked for this; send immediately, do not queue behind app traffic.
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.outboundQueue.unshift(msg);
    }
  }

  joinQueue(game: string) {
    this.send({ type: "queue.join", game });
  }

  sendRelay(payload: Uint8Array) {
    if (!this.matchId) {
      this.cfg.onError?.("relay_before_match");
      return;
    }
    const frameText = this.textDecoder.decode(payload);
    const envelope = JSON.stringify({ t: "frame", data: frameText });
    this.send({
      type: "relay",
      matchId: this.matchId,
      payload: envelope,
    });
  }

  getTransport(): Transport {
    return {
      send: (frame) => this.sendRelay(frame),
      onFrame: (cb) => {
        this.frameCallback = cb;
      },
    };
  }

  private send(obj: unknown) {
    if (this.explicitlyClosed) {
      this.cfg.onError?.("client_closed");
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN && this.authed) {
      this.ws.send(JSON.stringify(obj));
    } else {
      this.outboundQueue.push(obj);
    }
  }

  private flushOutboundQueue() {
    while (
      this.ws.readyState === WebSocket.OPEN &&
      this.authed &&
      this.outboundQueue.length > 0
    ) {
      const obj = this.outboundQueue.shift();
      this.ws.send(JSON.stringify(obj));
    }
  }

  close() {
    this.explicitlyClosed = true;
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(new Error("pvp_client_closed"));
    }
    this.cleanup();
    // After cleanup removes listeners, attach a no-op error handler so that a
    // CONNECTING-close error from the `ws` package is not emitted unhandled.
    this.ws.on("error", () => {});
    this.ws.close();
  }
}
