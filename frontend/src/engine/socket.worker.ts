/**
 * The shared SOCKET worker (ADR-0030, Phase 2). Owns the ONE relay {@link MpClient} — a single
 * WebSocket for every PvP window — while each game runs in its own game worker. `engineClient` posts
 * `{type:"config"}` once, then `{type:"attach"}` transferring one end of a `MessageChannel` per game
 * worker; each port gets a {@link SocketHost} that bridges that worker's {@link RemoteMpClient} to the
 * shared socket. The socket's lifecycle is broadcast to every port so each session reflects drop/resume.
 *
 * Not a Comlink worker: it speaks the raw {@link BridgePort} protocol (frames/peer are hot-path and
 * want no proxy overhead), so it uses `self.onmessage` directly to receive config + transferred ports.
 */
import { MpClient } from "@/pvp/mpClient";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { SocketHost } from "./pool/socketHost";
import type { BridgePort } from "./pool/socketBridge";
import type { ConnStatus, EngineConfig } from "./engineApi";

let cfg: EngineConfig | null = null;
let ready: Promise<MpClient> | null = null;
let connStatus: ConnStatus = "closed";
const ports: MessagePort[] = [];

function broadcastConn(): void {
  for (const p of ports) p.postMessage({ k: "conn", status: connStatus });
}

/** Open the one shared socket (memoized). The connection ephemeral authenticates the socket only —
 *  each match still mints its own tunnel ephemeral inside its game worker's session. */
function ensureSocket(config: EngineConfig): Promise<MpClient> {
  if (ready) return ready;
  const client = new MpClient(config.mpWsUrl, config.wallet, generateKeyPair());
  connStatus = "connecting";
  broadcastConn();
  client.onClose = () => {
    connStatus = "reconnecting";
    broadcastConn();
  };
  client.onResumeOk(() => {
    connStatus = "open";
    broadcastConn();
  });
  ready = client.connect().then(() => {
    connStatus = "open";
    broadcastConn();
    return client;
  });
  return ready;
}

self.onmessage = (ev: MessageEvent): void => {
  const m = ev.data as { type?: string; config?: EngineConfig };
  if (m?.type === "config") {
    cfg = m.config ?? null;
    if (cfg) void ensureSocket(cfg);
    return;
  }
  if (m?.type === "attach") {
    const port = ev.ports[0];
    if (!port || !cfg) return;
    ports.push(port);
    // Tell the newcomer the current status right away; then bind its host once the socket is up. The
    // port buffers the game worker's early requests until SocketHost sets onmessage, so none are lost.
    port.postMessage({ k: "conn", status: connStatus });
    void ensureSocket(cfg).then((client) => {
      new SocketHost(client, port as unknown as BridgePort);
    });
    return;
  }
};
