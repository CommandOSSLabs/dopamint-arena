import { describe, it } from "node:test";
import assert from "node:assert";
import { core } from "sui-tunnel-ts";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { GAME_KITS } from "@/agent/gameKit";
import { linkedLoopback } from "./loopbackTransport";
import { PvpGameSession } from "./pvpGameSession";
import type {
  MatchChannel,
  SettlementSigner,
} from "./seams";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seeded(seed: number) {
  return () => seededRng(seed);
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const i = setInterval(() => {
      if (predicate()) { clearInterval(i); res(); }
      else if (Date.now() - t0 > timeoutMs) {
        clearInterval(i);
        rej(new Error(`waitFor timeout after ${timeoutMs}ms`));
      }
    }, 2);
  });
}

// ---------------------------------------------------------------------------
// Fake settle half relay pair
//
// Wires the sendSettleHalf / onSettleHalf seam between two sessions.
// ---------------------------------------------------------------------------

interface FakeSettleChannel extends MatchChannel {
  sendSettleHalf(half: { sig: string; root: string }): void;
  onSettleHalf(cb: (half: { sig: string; root: string }) => void): void;
}

function makeFakeSettleChannelPair(
  transportA: ReturnType<typeof linkedLoopback>["a"],
  transportB: ReturnType<typeof linkedLoopback>["b"],
): { chA: FakeSettleChannel; chB: FakeSettleChannel } {
  function makeChannel(transport: typeof transportA): FakeSettleChannel & {
    _deliverSettle(half: { sig: string; root: string }): void;
  } {
    let settleCb: ((h: { sig: string; root: string }) => void) | null = null;
    let settleBuffer: { sig: string; root: string } | null = null;

    return {
      transport,
      partyHello(_: string) {},
      onPeerHello(_: (hex: string) => void) {},
      announceOpened(_: string) {},
      onOpened(_: (id: string) => void) {},
      sendSettleHalf(_h: { sig: string; root: string }) {
        // patched after construction
      },
      onSettleHalf(cb: (h: { sig: string; root: string }) => void) {
        if (settleBuffer !== null) {
          const buf = settleBuffer;
          settleBuffer = null;
          cb(buf);
        } else {
          settleCb = cb;
        }
      },
      _deliverSettle(h: { sig: string; root: string }) {
        if (settleCb) {
          const cb = settleCb;
          settleCb = null;
          cb(h);
        } else {
          settleBuffer = h;
        }
      },
    };
  }

  const rawA = makeChannel(transportA);
  const rawB = makeChannel(transportB);

  rawA.sendSettleHalf = (h) => rawB._deliverSettle(h);
  rawB.sendSettleHalf = (h) => rawA._deliverSettle(h);

  return { chA: rawA, chB: rawB };
}

// ---------------------------------------------------------------------------
// Fake SettlementSigner with configurable submit behaviour
// ---------------------------------------------------------------------------

type SubmitBehaviour = "ok" | "both-fail";

function makeFakeSettlementSigner(behaviour: SubmitBehaviour = "ok"): {
  signer: SettlementSigner;
  submitCallCount: () => number;
} {
  let calls = 0;
  const signer: SettlementSigner = {
    async openAndFundSeatA() { return { tunnelId: "0x" + "cd".repeat(32) }; },
    async depositSeatB() {},
    async submitCooperativeClose(_args) {
      calls++;
      if (behaviour === "ok") return { digest: "0xfeedcafe" };
      // "both-fail": always reject — backend→wallet fallback is the real adapter's job (Task 7).
      throw new Error("submitCooperativeClose hard-fail");
    },
    async closeOnTimeout() { return { digest: "0xdeadbeef" }; },
  };
  return { signer, submitCallCount: () => calls };
}

// ---------------------------------------------------------------------------
// Build two loopback sessions that share tunnels, run to terminal, and expose
// the settle-channel seam for cooperative close.
// ---------------------------------------------------------------------------

async function runToTerminal(opts?: { seed?: number }) {
  const kit = GAME_KITS["tictactoe"];
  const backend = defaultBackend();
  const tunnelId = "0x" + "ab".repeat(32);
  const { a: txA, b: txB } = linkedLoopback();

  const keyA = core.generateKeyPair();
  const keyB = core.generateKeyPair();

  const { chA, chB } = makeFakeSettleChannelPair(txA, txB);

  const dtA = new core.DistributedTunnel(kit.protocol as never, {
    tunnelId,
    selfParty: "A",
    self: core.makeEndpoint(backend, "0xA", keyA, true),
    opponent: core.makeEndpoint(backend, "0xB", { publicKey: keyB.publicKey, scheme: keyB.scheme }, false),
  }, txA, { a: 100n, b: 100n });

  const dtB = new core.DistributedTunnel(kit.protocol as never, {
    tunnelId,
    selfParty: "B",
    self: core.makeEndpoint(backend, "0xB", keyB, true),
    opponent: core.makeEndpoint(backend, "0xA", { publicKey: keyA.publicKey, scheme: keyA.scheme }, false),
  }, txB, { a: 100n, b: 100n });

  const seed = opts?.seed ?? 1;
  const sA = new PvpGameSession(kit, "A", { rngForSeat: seeded(seed) });
  const sB = new PvpGameSession(kit, "B", { rngForSeat: seeded(seed + 1) });

  sA.attachTunnel({ tunnel: dtA as never, initialState: kit.protocol.initialState({ tunnelId, initialBalances: { a: 100n, b: 100n } }) });
  sB.attachTunnel({ tunnel: dtB as never, initialState: kit.protocol.initialState({ tunnelId, initialBalances: { a: 100n, b: 100n } }) });

  sA.setAuto(true);
  sB.setAuto(true);
  sA.kickoff();

  await waitFor(() => sA.getSnapshot().terminal && sB.getSnapshot().terminal);
  assert.strictEqual(sA.getSnapshot().phase, "settling");
  assert.strictEqual(sB.getSnapshot().phase, "settling");

  return { sA, sB, chA, chB, dtA, dtB, tunnelId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PvpGameSession cooperative close", () => {
  it("both seats compute the same transcript root", async () => {
    const { sA, sB } = await runToTerminal({ seed: 10 });

    const rootA = sA.transcriptRootHex();
    const rootB = sB.transcriptRootHex();

    assert.ok(rootA.length > 0, "transcript root must be non-empty");
    assert.strictEqual(rootA, rootB, "both seats must derive the same transcript root");
  });

  it("settle path: phase -> 'done', only seat A calls submitCooperativeClose", async () => {
    const { sA, sB, chA, chB } = await runToTerminal({ seed: 20 });

    const { signer: signerA, submitCallCount: countA } = makeFakeSettlementSigner("ok");
    const { signer: signerB, submitCallCount: countB } = makeFakeSettlementSigner("ok");

    const settleA = sA.settle({ channel: chA, settlementSigner: signerA, createdAt: 0n, onchainNonce: 0n });
    const settleB = sB.settle({ channel: chB, settlementSigner: signerB, createdAt: 0n, onchainNonce: 0n });

    await Promise.all([settleA, settleB]);

    assert.strictEqual(sA.getSnapshot().phase, "done", "sA phase must be done");
    assert.strictEqual(sB.getSnapshot().phase, "done", "sB phase must be done");
    assert.strictEqual(countA(), 1, "seat A must call submitCooperativeClose exactly once");
    assert.strictEqual(countB(), 0, "seat B must NOT call submitCooperativeClose");
    assert.ok(sA.getSnapshot().digest, "sA snapshot must include a digest");
  });

  it("root mismatch -> phase 'error', no submit", async () => {
    const { sA, sB, chA } = await runToTerminal({ seed: 30 });

    // Build a "lying" channel for B that sends a wrong root to A.
    const { b: txB2 } = linkedLoopback(); // unused transport; only settle messages matter
    let aSettleHalfCb: ((h: { sig: string; root: string }) => void) | null = null;
    const lyingChB: MatchChannel & {
      sendSettleHalf(h: { sig: string; root: string }): void;
      onSettleHalf(cb: (h: { sig: string; root: string }) => void): void;
    } = {
      transport: txB2,
      partyHello() {},
      onPeerHello() {},
      announceOpened() {},
      onOpened() {},
      sendSettleHalf(h) {
        // Deliver a tampered root to A's onSettleHalf listener.
        const tampered = { ...h, root: "0x" + "ff".repeat(32) };
        if (aSettleHalfCb) {
          aSettleHalfCb(tampered);
        }
      },
      onSettleHalf(cb) {
        // B never actually gets a real half in this test; provide a no-op waiter.
        void cb; // register but never call (the test ends on A's error)
      },
    };

    // Patch chA so that A forwards its half to lyingChB and receives B's tampered half.
    const realChA = chA as FakeSettleChannel & { _deliverSettle(h: { sig: string; root: string }): void };
    const origSend = realChA.sendSettleHalf.bind(realChA);
    realChA.sendSettleHalf = (h) => {
      origSend(h); // still deliver to original peer (unused here)
      lyingChB.sendSettleHalf(h); // trigger tampered response to A
    };
    // Wire A's onSettleHalf so the lying channel can reach it.
    const origOnSettle = realChA.onSettleHalf.bind(realChA);
    realChA.onSettleHalf = (cb) => {
      aSettleHalfCb = cb;
      origOnSettle(cb);
    };

    const { signer: signerA, submitCallCount: countA } = makeFakeSettlementSigner("ok");

    // Start A's settle — A sends its half then awaits the peer's half.
    const settleA = sA.settle({ channel: realChA, settlementSigner: signerA, createdAt: 0n, onchainNonce: 0n });

    // Start B's settle with the lying channel so it sends the tampered half to A
    // via lyingChB.sendSettleHalf.  B's own settle will hang (lyingChB.onSettleHalf
    // never fires) — intentional; we only need A to reach "error".
    const { signer: signerB } = makeFakeSettlementSigner("ok");
    void sB.settle({ channel: lyingChB, settlementSigner: signerB, createdAt: 0n, onchainNonce: 0n });

    // A should reach "error" once it receives the tampered half from B.
    await settleA;

    assert.strictEqual(sA.getSnapshot().phase, "error", "root mismatch must set phase error");
    assert.strictEqual(countA(), 0, "no submit on root mismatch");
  });

  it("combineSettlementWithRoot succeeds (no throw)", async () => {
    const { sA, sB, chA, chB } = await runToTerminal({ seed: 40 });

    const { signer: signerA } = makeFakeSettlementSigner("ok");
    const { signer: signerB } = makeFakeSettlementSigner("ok");

    // If combineSettlementWithRoot throws, settle() routes to fail() -> "error".
    await Promise.all([
      sA.settle({ channel: chA, settlementSigner: signerA, createdAt: 0n, onchainNonce: 0n }),
      sB.settle({ channel: chB, settlementSigner: signerB, createdAt: 0n, onchainNonce: 0n }),
    ]);

    assert.strictEqual(sA.getSnapshot().phase, "done", "combine must not throw");
  });

  it("hard submit failure routes seat A to 'error'", async () => {
    const { sA, sB, chA, chB } = await runToTerminal({ seed: 50 });

    const { signer: signerA } = makeFakeSettlementSigner("both-fail");
    const { signer: signerB } = makeFakeSettlementSigner("ok");

    await Promise.all([
      sA.settle({ channel: chA, settlementSigner: signerA, createdAt: 0n, onchainNonce: 0n }),
      sB.settle({ channel: chB, settlementSigner: signerB, createdAt: 0n, onchainNonce: 0n }),
    ]);

    assert.strictEqual(sA.getSnapshot().phase, "error", "hard submit failure must set error phase");
  });
});
