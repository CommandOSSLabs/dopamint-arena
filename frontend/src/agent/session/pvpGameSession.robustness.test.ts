import { describe, it } from "node:test";
import assert from "node:assert";
import { core } from "sui-tunnel-ts";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { GAME_KITS } from "@/agent/gameKit";
import { linkedLoopback } from "./loopbackTransport";
import { PvpGameSession } from "./pvpGameSession";
import type { MatchChannel, SettlementSigner, SessionTransport } from "./seams";

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

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const i = setInterval(() => {
      if (predicate()) {
        clearInterval(i);
        res();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(i);
        rej(new Error(`waitFor timeout after ${timeoutMs}ms`));
      }
    }, 2);
  });
}

// ---------------------------------------------------------------------------
// Fake settle channel pair (mirrors settle.test.ts helper)
// ---------------------------------------------------------------------------

interface FakeSettleChannel extends MatchChannel {
  sendSettleHalf(half: { sig: string; root: string }): void;
  onSettleHalf(cb: (half: { sig: string; root: string }) => void): void;
}

function makeFakeSettleChannelPair(
  transportA: SessionTransport,
  transportB: SessionTransport,
): { chA: FakeSettleChannel; chB: FakeSettleChannel } {
  function makeChannel(transport: SessionTransport): FakeSettleChannel & {
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
// Build two loopback sessions that share tunnels, run to terminal.
// Returns the transports separately so tests can simulate disconnects.
// ---------------------------------------------------------------------------

async function runToTerminal(opts?: { seed?: number }) {
  const kit = GAME_KITS["tictactoe"];
  const backend = defaultBackend();
  const tunnelId = "0x" + "ab".repeat(32);
  const { a: txA, b: txB } = linkedLoopback();

  const keyA = core.generateKeyPair();
  const keyB = core.generateKeyPair();

  const dtA = new core.DistributedTunnel(
    kit.protocol as never,
    {
      tunnelId,
      selfParty: "A",
      self: core.makeEndpoint(backend, "0xA", keyA, true),
      opponent: core.makeEndpoint(
        backend,
        "0xB",
        { publicKey: keyB.publicKey, scheme: keyB.scheme },
        false,
      ),
    },
    txA,
    { a: 100n, b: 100n },
  );

  const dtB = new core.DistributedTunnel(
    kit.protocol as never,
    {
      tunnelId,
      selfParty: "B",
      self: core.makeEndpoint(backend, "0xB", keyB, true),
      opponent: core.makeEndpoint(
        backend,
        "0xA",
        { publicKey: keyA.publicKey, scheme: keyA.scheme },
        false,
      ),
    },
    txB,
    { a: 100n, b: 100n },
  );

  const seed = opts?.seed ?? 1;
  // Use a short move timeout so tests don't wait multi-seconds
  const sA = new PvpGameSession(
    kit,
    "A",
    { rngForSeat: seeded(seed) },
    undefined,
    { moveTimeoutMs: 30, settleTimeoutMs: 30 },
  );
  const sB = new PvpGameSession(
    kit,
    "B",
    { rngForSeat: seeded(seed + 1) },
    undefined,
    { moveTimeoutMs: 30, settleTimeoutMs: 30 },
  );

  sA.attachTunnel({
    tunnel: dtA as never,
    initialState: kit.protocol.initialState({
      tunnelId,
      initialBalances: { a: 100n, b: 100n },
    }),
    transport: txA,
  });
  sB.attachTunnel({
    tunnel: dtB as never,
    initialState: kit.protocol.initialState({
      tunnelId,
      initialBalances: { a: 100n, b: 100n },
    }),
    transport: txB,
  });

  sA.setAuto(true);
  sB.setAuto(true);
  sA.kickoff();

  await waitFor(() => sA.getSnapshot().terminal && sB.getSnapshot().terminal);

  const { chA, chB } = makeFakeSettleChannelPair(txA, txB);
  return { sA, sB, txA, txB, dtA, dtB, tunnelId, chA, chB };
}

// ---------------------------------------------------------------------------
// Fake SettlementSigner
// ---------------------------------------------------------------------------

function makeFakeSettlementSigner(opts?: { closeOnTimeoutFails?: boolean }): {
  signer: SettlementSigner;
  closeOnTimeoutCallCount: () => number;
  capturedTunnelId: () => string | null;
} {
  let timeoutCalls = 0;
  let captured: string | null = null;
  const signer: SettlementSigner = {
    async openAndFundSeatA() {
      return { tunnelId: "0x" + "cd".repeat(32) };
    },
    async depositSeatB() {},
    async submitCooperativeClose() {
      return { digest: "0xfeedcafe" };
    },
    async closeOnTimeout(args: { tunnelId: string }) {
      timeoutCalls++;
      captured = args.tunnelId;
      if (opts?.closeOnTimeoutFails) throw new Error("closeOnTimeout failed");
      return { digest: "0xdeadbeef" };
    },
  };
  return {
    signer,
    closeOnTimeoutCallCount: () => timeoutCalls,
    capturedTunnelId: () => captured,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PvpGameSession robustness", () => {
  it("transport close mid-game -> phase 'opponent-abandoned'", async () => {
    const kit = GAME_KITS["tictactoe"];
    const tunnelId = "0x" + "ab".repeat(32);
    const { a: txA, b: txB } = linkedLoopback();
    const backend = defaultBackend();
    const keyA = core.generateKeyPair();
    const keyB = core.generateKeyPair();

    const dtA = new core.DistributedTunnel(
      kit.protocol as never,
      {
        tunnelId,
        selfParty: "A",
        self: core.makeEndpoint(backend, "0xA", keyA, true),
        opponent: core.makeEndpoint(
          backend,
          "0xB",
          { publicKey: keyB.publicKey, scheme: keyB.scheme },
          false,
        ),
      },
      txA,
      { a: 100n, b: 100n },
    );

    const sA = new PvpGameSession(
      kit,
      "A",
      { rngForSeat: seeded(10) },
      undefined,
      { moveTimeoutMs: 5000, settleTimeoutMs: 5000 },
    );
    sA.attachTunnel({
      tunnel: dtA as never,
      initialState: kit.protocol.initialState({
        tunnelId,
        initialBalances: { a: 100n, b: 100n },
      }),
      transport: txA,
    });

    assert.strictEqual(sA.getSnapshot().phase, "playing");

    // Simulate the peer closing the connection.
    txA.close();

    assert.strictEqual(
      sA.getSnapshot().phase,
      "opponent-abandoned",
      "transport close must set phase to opponent-abandoned",
    );

    sA.dispose();
  });

  it("transport error mid-game -> phase 'opponent-abandoned'", async () => {
    const kit = GAME_KITS["tictactoe"];
    const tunnelId = "0x" + "ab".repeat(32);
    const { a: txA } = linkedLoopback();
    const backend = defaultBackend();
    const keyA = core.generateKeyPair();
    const keyB = core.generateKeyPair();

    const dtA = new core.DistributedTunnel(
      kit.protocol as never,
      {
        tunnelId,
        selfParty: "A",
        self: core.makeEndpoint(backend, "0xA", keyA, true),
        opponent: core.makeEndpoint(
          backend,
          "0xB",
          { publicKey: keyB.publicKey, scheme: keyB.scheme },
          false,
        ),
      },
      txA,
      { a: 100n, b: 100n },
    );

    // Use a custom transport that exposes an errored() trigger
    class TestTransport implements SessionTransport {
      private frameCb: ((f: Uint8Array) => void) | null = null;
      private closeCb: (() => void) | null = null;
      private errorCb: ((err: unknown) => void) | null = null;
      send(_f: Uint8Array) {}
      onFrame(cb: (f: Uint8Array) => void) {
        this.frameCb = cb;
        void this.frameCb;
      }
      onClose(cb: () => void) {
        this.closeCb = cb;
        void this.closeCb;
      }
      onError(cb: (err: unknown) => void) {
        this.errorCb = cb;
      }
      close() {
        this.closeCb?.();
      }
      errored(err: unknown) {
        this.errorCb?.(err);
      }
    }

    const tx = new TestTransport();
    const sA = new PvpGameSession(
      kit,
      "A",
      { rngForSeat: seeded(11) },
      undefined,
      { moveTimeoutMs: 5000, settleTimeoutMs: 5000 },
    );
    sA.attachTunnel({
      tunnel: dtA as never,
      initialState: kit.protocol.initialState({
        tunnelId,
        initialBalances: { a: 100n, b: 100n },
      }),
      transport: tx,
    });

    assert.strictEqual(sA.getSnapshot().phase, "playing");

    tx.errored(new Error("network error"));

    assert.strictEqual(
      sA.getSnapshot().phase,
      "opponent-abandoned",
      "transport error must set phase to opponent-abandoned",
    );

    sA.dispose();
  });

  it("move timeout (no ACK) -> phase 'opponent-abandoned'", async () => {
    const kit = GAME_KITS["tictactoe"];
    const tunnelId = "0x" + "ab".repeat(32);
    // Use a blackhole transport: B side never sends back ACKs
    class BlackholeTransport implements SessionTransport {
      private closeCb: (() => void) | null = null;
      send(_f: Uint8Array) {
        /* drop it */
      }
      onFrame(_cb: (f: Uint8Array) => void) {}
      onClose(cb: () => void) {
        this.closeCb = cb;
        void this.closeCb;
      }
      onError(_cb: (err: unknown) => void) {}
      close() {
        this.closeCb?.();
      }
    }

    const backend = defaultBackend();
    const keyA = core.generateKeyPair();
    const keyB = core.generateKeyPair();
    const blackhole = new BlackholeTransport();

    const dtA = new core.DistributedTunnel(
      kit.protocol as never,
      {
        tunnelId,
        selfParty: "A",
        self: core.makeEndpoint(backend, "0xA", keyA, true),
        opponent: core.makeEndpoint(
          backend,
          "0xB",
          { publicKey: keyB.publicKey, scheme: keyB.scheme },
          false,
        ),
      },
      blackhole,
      { a: 100n, b: 100n },
    );

    // Use very short move timeout so the test doesn't wait long
    const sA = new PvpGameSession(
      kit,
      "A",
      { rngForSeat: seeded(12) },
      undefined,
      { moveTimeoutMs: 30, settleTimeoutMs: 30 },
    );
    sA.attachTunnel({
      tunnel: dtA as never,
      initialState: kit.protocol.initialState({
        tunnelId,
        initialBalances: { a: 100n, b: 100n },
      }),
      transport: blackhole,
    });

    sA.setAuto(true);
    sA.kickoff(); // drive() proposes a move that never gets ACK'd

    await waitFor(() => sA.getSnapshot().phase === "opponent-abandoned", 500);
    assert.strictEqual(
      sA.getSnapshot().phase,
      "opponent-abandoned",
      "move timeout must set phase to opponent-abandoned",
    );

    sA.dispose();
  });

  it("settle-half timeout -> closeOnTimeout called -> phase 'opponent-abandoned'", async () => {
    const { sA, txA, tunnelId } = await runToTerminal({ seed: 20 });

    // Channel where onSettleHalf never fires (simulates peer not responding)
    const hangingChannel: MatchChannel = {
      transport: txA,
      partyHello() {},
      onPeerHello() {},
      announceOpened() {},
      onOpened() {},
      sendSettleHalf() {},
      onSettleHalf(_cb) {
        /* never fires */
      },
    };

    const { signer, closeOnTimeoutCallCount, capturedTunnelId } =
      makeFakeSettlementSigner();

    // settle() should race against the timeout and escalate
    await sA.settle({
      channel: hangingChannel,
      settlementSigner: signer,
      createdAt: 0n,
      onchainNonce: 0n,
    });

    assert.strictEqual(
      closeOnTimeoutCallCount(),
      1,
      "settle-half timeout must call closeOnTimeout exactly once",
    );
    assert.strictEqual(
      sA.getSnapshot().phase,
      "opponent-abandoned",
      "settle-half timeout must set phase to opponent-abandoned after closeOnTimeout",
    );

    assert.strictEqual(
      capturedTunnelId(),
      tunnelId,
      "tunnelId passed to closeOnTimeout should match the session's tunnel",
    );

    sA.dispose();
  });

  it("settle-half timeout when closeOnTimeout fails -> still 'opponent-abandoned'", async () => {
    const { sA, txA } = await runToTerminal({ seed: 30 });

    const hangingChannel: MatchChannel = {
      transport: txA,
      partyHello() {},
      onPeerHello() {},
      announceOpened() {},
      onOpened() {},
      sendSettleHalf() {},
      onSettleHalf(_cb) {
        /* never fires */
      },
    };

    const { signer, closeOnTimeoutCallCount } = makeFakeSettlementSigner({
      closeOnTimeoutFails: true,
    });

    await sA.settle({
      channel: hangingChannel,
      settlementSigner: signer,
      createdAt: 0n,
      onchainNonce: 0n,
    });

    assert.strictEqual(
      closeOnTimeoutCallCount(),
      1,
      "closeOnTimeout must be called once even if it fails",
    );
    assert.strictEqual(
      sA.getSnapshot().phase,
      "opponent-abandoned",
      "phase must still be opponent-abandoned even if closeOnTimeout throws",
    );

    sA.dispose();
  });

  it("both settle paths fail -> phase 'error' (not abandoned)", async () => {
    const { sA, sB, chA, chB } = await runToTerminal({ seed: 40 });

    const failSigner: SettlementSigner = {
      async openAndFundSeatA() {
        return { tunnelId: "" };
      },
      async depositSeatB() {},
      async submitCooperativeClose() {
        throw new Error("backend and wallet both failed");
      },
      async closeOnTimeout() {
        return { digest: "0xdeadbeef" };
      },
    };
    const okSigner: SettlementSigner = {
      async openAndFundSeatA() {
        return { tunnelId: "" };
      },
      async depositSeatB() {},
      async submitCooperativeClose() {
        return { digest: "0xfeedcafe" };
      },
      async closeOnTimeout() {
        return { digest: "0xdeadbeef" };
      },
    };

    await Promise.all([
      sA.settle({
        channel: chA,
        settlementSigner: failSigner,
        createdAt: 0n,
        onchainNonce: 0n,
      }),
      sB.settle({
        channel: chB,
        settlementSigner: okSigner,
        createdAt: 0n,
        onchainNonce: 0n,
      }),
    ]);

    assert.strictEqual(
      sA.getSnapshot().phase,
      "error",
      "submitCooperativeClose failure must set phase to error",
    );

    sA.dispose();
    sB.dispose();
  });

  it("abandon is idempotent: does not overwrite 'done' phase", async () => {
    const { sA, sB, chA, chB } = await runToTerminal({ seed: 50 });

    const { signer: signerA } = makeFakeSettlementSigner();
    const { signer: signerB } = makeFakeSettlementSigner();

    await Promise.all([
      sA.settle({
        channel: chA,
        settlementSigner: signerA,
        createdAt: 0n,
        onchainNonce: 0n,
      }),
      sB.settle({
        channel: chB,
        settlementSigner: signerB,
        createdAt: 0n,
        onchainNonce: 0n,
      }),
    ]);

    assert.strictEqual(sA.getSnapshot().phase, "done");

    // Simulate transport close AFTER a successful settle — must not revert to abandoned.
    (chA.transport as SessionTransport).close();

    assert.strictEqual(
      sA.getSnapshot().phase,
      "done",
      "transport close after done must not change phase",
    );

    sA.dispose();
    sB.dispose();
  });
});
