import { test, expect } from "bun:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { connectRelaySeat } from "./relayChannel";

// Minimal fake that scripts the server side: challenge -> expect connect+queue.join -> match.found.
class FakeWS {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) { queueMicrotask(() => { this.onopen?.(); this.srv({ type: "challenge", nonce: "n1" }); }); }
  send(s: string) {
    this.sent.push(s);
    const m = JSON.parse(s);
    if (m.type === "queue.join") this.srv({ type: "match.found", matchId: "m1", role: "A", opponentWallet: "0xB", game: m.game });
  }
  srv(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
  close() {}
}

test("handshake completes and resolves on match.found", async () => {
  const seat = await connectRelaySeat({ url: "ws://x/v1/mp", game: "bench-1", keypair: new Ed25519Keypair(), WebSocketCtor: FakeWS as any });
  expect(seat.matchId).toBe("m1");
  expect(seat.role).toBe("A");
});

test("inbound relay frame surfaces as engine bytes; outbound send wraps as relay payload", async () => {
  let captured: FakeWS | null = null;
  class Spy extends FakeWS { constructor(u: string) { super(u); captured = this; } }
  const seat = await connectRelaySeat({ url: "ws://x/v1/mp", game: "bench-2", keypair: new Ed25519Keypair(), WebSocketCtor: Spy as any });
  const got: string[] = [];
  seat.transport.onFrame((f) => got.push(new TextDecoder().decode(f)));
  const inner = JSON.stringify({ kind: "ack", nonce: "1", sigResponder: "ab" });
  captured!.srv({ type: "relay", matchId: "m1", payload: JSON.stringify({ t: "frame", kind: "ack", data: inner }) });
  expect(got).toEqual([inner]);
  seat.transport.send(new TextEncoder().encode(inner));
  const last = JSON.parse(captured!.sent.at(-1)!);
  expect(last.type).toBe("relay");
  expect(JSON.parse(last.payload).t).toBe("frame");
});
