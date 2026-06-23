import test from "node:test";
import assert from "node:assert/strict";
import { MpClient } from "./mpClient";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";

// Two FakeWebSockets cross-wired: a relay frame sent by one is received by the other.
function fakeRelayPair() {
  const peers: FakeWS[] = [];
  class FakeWS {
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(_url: string) {
      peers.push(this);
    }
    send(s: string) {
      const m = JSON.parse(s);
      if (m.type === "relay") {
        const other = peers.find((p) => p !== this);
        other?.onmessage?.({
          data: JSON.stringify({
            type: "relay",
            matchId: m.matchId,
            payload: m.payload,
          }),
        });
      }
    }
    close() {
      this.onclose?.();
    }
    handshake() {
      this.onopen?.();
      this.onmessage?.({
        data: JSON.stringify({ type: "challenge", nonce: "n" }),
      });
    }
  }
  return { FakeWS, peers };
}

test("engine frames and peer messages round-trip across two MpClients (envelope parity)", async () => {
  const { FakeWS, peers } = fakeRelayPair();
  const opts = {
    WebSocketCtor: FakeWS as unknown as typeof WebSocket,
  } as never;
  const a = new MpClient("ws://x", "0xa", generateKeyPair() as never, opts);
  const b = new MpClient("ws://x", "0xb", generateKeyPair() as never, opts);
  const pa = a.connect();
  peers[0].handshake();
  await pa;
  const pb = b.connect();
  peers[1].handshake();
  await pb;

  const chA = a.channel("m1");
  const chB = b.channel("m1");
  let frame: Uint8Array | null = null;
  let peerMsg: unknown = null;
  chB.transport.onFrame((bytes) => {
    frame = bytes;
  });
  chB.onPeer((m) => {
    peerMsg = m;
  });

  chA.transport.send(
    new TextEncoder().encode(JSON.stringify({ kind: "move", nonce: "1" })),
  );
  chA.sendPeer({ t: "hello", ephemeralPubkey: "deadbeef" } as never);

  assert.equal(
    JSON.parse(new TextDecoder().decode(frame!)).kind,
    "move",
    "frame survives the {t:frame,data} envelope",
  );
  assert.deepEqual(peerMsg, { t: "hello", ephemeralPubkey: "deadbeef" });
});

test("stake peer-message round-trips across two MpClients", async () => {
  const { FakeWS, peers } = fakeRelayPair();
  const opts = {
    WebSocketCtor: FakeWS as unknown as typeof WebSocket,
  } as never;
  const a = new MpClient("ws://x", "0xa", generateKeyPair() as never, opts);
  const b = new MpClient("ws://x", "0xb", generateKeyPair() as never, opts);
  const pa = a.connect();
  peers[0].handshake();
  await pa;
  const pb = b.connect();
  peers[1].handshake();
  await pb;

  const chA = a.channel("m1");
  const chB = b.channel("m1");
  let got: unknown = null;
  chB.onPeer((m) => {
    got = m;
  });
  chA.sendPeer({ t: "stake", amount: 500 });
  assert.deepEqual(got, { t: "stake", amount: 500 });
});
