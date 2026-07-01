/**
 * Socket-worker-side bridge for ONE game worker's port (ADR-0030, Phase 2). Translates that game
 * worker's {@link RemoteMpClient} calls onto the shared {@link MpClient} — the single relay socket —
 * and routes THIS match's inbound engine frames + peer messages back down the port. One SocketHost
 * per connected game worker; the shared `MpClient` already multiplexes many matches over one socket
 * (its `#relayHandlers` map), so each host just owns the channels for its own worker's matches.
 */
import type { MpClient, PvpChannel } from "@/pvp/mpClient";
import type { BridgePort, BridgeRequest } from "./socketBridge";

export class SocketHost {
  /** Real channels for the matches this worker owns, keyed by matchId (frees on release). */
  readonly #channels = new Map<string, PvpChannel>();

  constructor(
    private readonly mp: MpClient,
    private readonly port: BridgePort,
  ) {
    port.onmessage = (ev) => this.#onRequest(ev.data as BridgeRequest);
    // The MpClient fires resume/peer events GLOBALLY over the shared socket; forward only the ones
    // for matches THIS worker owns (its `#channels`), so each game worker gets exactly its own.
    mp.onResumeOk((e) => {
      if (this.#channels.has(e.matchId)) port.postMessage({ k: "resumeOk", e });
    });
    mp.onPeerResumed((e) => {
      if (this.#channels.has(e.matchId))
        port.postMessage({ k: "peerResumed", e });
    });
    mp.onPeerDropped((e) => {
      if (this.#channels.has(e.matchId))
        port.postMessage({ k: "peerDropped", e });
    });
  }

  /** Open the real relay channel for a match and pump its frames/peer down the port. Idempotent: a
   *  match is set up once — eagerly on delivery (no drop window) and again on the game's `openChannel`
   *  or `resume`; the second call is a no-op. `addPeerListener` (not `onPeer`) so nothing clobbers it. */
  #setupChannel(matchId: string): void {
    if (this.#channels.has(matchId)) return;
    const ch = this.mp.channel(matchId);
    ch.transport.onFrame((bytes) =>
      this.port.postMessage({ k: "frame", matchId, bytes }),
    );
    ch.addPeerListener((msg) =>
      this.port.postMessage({ k: "peer", matchId, msg }),
    );
    this.#channels.set(matchId, ch);
  }

  #onRequest(r: BridgeRequest): void {
    switch (r.k) {
      case "quickMatch":
        this.mp.quickMatch(r.game).then(
          (match) => {
            this.#setupChannel(match.matchId); // eager: route before we even reply, no drop window
            this.port.postMessage({ k: "matchOk", reqId: r.reqId, match });
          },
          (e) => this.#failMatch(r.reqId, e),
        );
        return;
      case "joinMatch":
        this.mp.joinMatch(r.matchId).then(
          (match) => {
            this.#setupChannel(match.matchId);
            this.port.postMessage({ k: "matchOk", reqId: r.reqId, match });
          },
          (e) => this.#failMatch(r.reqId, e),
        );
        return;
      case "openChannel":
        this.#setupChannel(r.matchId);
        return;
      case "sendFrame":
        this.#channels.get(r.matchId)?.transport.send(r.bytes);
        return;
      case "sendPeer":
        this.#channels.get(r.matchId)?.sendPeer(r.msg);
        return;
      case "announce":
        this.mp.announceTunnel(r.matchId, r.tunnelId);
        return;
      case "release":
        this.mp.releaseMatch(r.matchId);
        this.#channels.delete(r.matchId);
        return;
      case "resume":
        // A cold-loaded match resumes onto the live socket, then routes to this worker's port.
        this.mp.resumeMatch(r.matchId);
        this.#setupChannel(r.matchId);
        return;
      case "markActive":
        // Register with the reconnect loop; the channel (owner) is set up by the preceding openChannel.
        this.mp.markActive(r.matchId);
        return;
    }
  }

  #failMatch(reqId: number, e: unknown): void {
    this.port.postMessage({
      k: "matchErr",
      reqId,
      error: String((e as Error)?.message ?? e),
    });
  }
}
