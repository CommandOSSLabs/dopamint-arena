/**
 * Message protocol for the socket-worker ↔ game-worker split (ADR-0029, Phase 2). The socket worker
 * owns the single relay {@link MpClient}; each game worker drives ONE match and its `mp` is a
 * {@link RemoteMpClient} that forwards these messages over a private `MessagePort`. Engine frames
 * (co-signed bytes) and peer messages cross verbatim — structured-cloned, never re-encoded — so
 * co-signing stays byte-identical across the extra hop.
 */
import type { MatchInfo, PeerMessage } from "@/pvp/mpClient";
import type { ConnStatus } from "@/engine/engineApi";

/** Peer messages that ride the side-channel (everything a match sends that isn't an engine frame). */
export type SidePeerMessage = Exclude<PeerMessage, { t: "frame" }>;

/** Game worker → socket worker. `reqId` correlates the async match calls with their reply. */
export type BridgeRequest =
  | { k: "quickMatch"; reqId: number; game: string }
  | { k: "joinMatch"; reqId: number; matchId: string }
  | { k: "openChannel"; matchId: string }
  | { k: "sendFrame"; matchId: string; bytes: Uint8Array }
  | { k: "sendPeer"; matchId: string; msg: SidePeerMessage }
  | { k: "announce"; matchId: string; tunnelId: string }
  | { k: "release"; matchId: string }
  | { k: "resume"; matchId: string };

/** Socket worker → game worker. */
export type BridgeEvent =
  | { k: "matchOk"; reqId: number; match: MatchInfo }
  | { k: "matchErr"; reqId: number; error: string }
  | { k: "frame"; matchId: string; bytes: Uint8Array }
  | { k: "peer"; matchId: string; msg: SidePeerMessage }
  | { k: "conn"; status: ConnStatus };

/** The `MessagePort` surface both sides use — structural so a Node `MessageChannel` port (adapted to
 *  the `onmessage` shape) drives the same classes under `node:test` as a real browser port in prod. */
export interface BridgePort {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
