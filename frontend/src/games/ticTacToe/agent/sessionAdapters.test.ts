// Light adapter tests: verify construction, delegation, and routing.
// Full e2e validation deferred to Task 8 + manual run (adapters touch browser + relay).
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { deriveEphemeral } from "../app/lib/pvpIdentity.js";
import {
  makeTttRelay,
  makeTttEndpointFactory,
  makeTttSettlementSigner,
} from "./sessionAdapters.js";

// ── makeTttEndpointFactory ──────────────────────────────────────────────────

describe("makeTttEndpointFactory", () => {
  it("self() publicKey equals eph.coreKey.publicKey", () => {
    const seed = new Uint8Array(32).fill(42);
    const eph = deriveEphemeral(seed);
    const factory = makeTttEndpointFactory(eph);
    assert.deepStrictEqual(factory.self().publicKey, eph.coreKey.publicKey);
  });

  it("buildConfig returns an object with tunnelId, self, opponent, selfParty", () => {
    const seed = new Uint8Array(32).fill(7);
    const eph = deriveEphemeral(seed);
    const factory = makeTttEndpointFactory(eph);

    const oppKey = new Uint8Array(32).fill(99);
    const cfg = factory.buildConfig({
      tunnelId: "0xabc",
      selfParty: "A",
      opponentPublicKey: oppKey,
      opponentAddress: "0xdeadbeef",
    }) as { tunnelId: string; selfParty: string; self: { publicKey: Uint8Array }; opponent: { publicKey: Uint8Array } };

    assert.equal(cfg.tunnelId, "0xabc");
    assert.equal(cfg.selfParty, "A");
    assert.deepStrictEqual(cfg.self.publicKey, eph.coreKey.publicKey);
    assert.deepStrictEqual(cfg.opponent.publicKey, oppKey);
  });
});

// ── makeTttSettlementSigner ─────────────────────────────────────────────────

describe("makeTttSettlementSigner", () => {
  // Base context — reads are not called through the overrides path.
  const baseCtx = {
    walletAddress: "0xwallet",
    opponentAddress: "0xopponent",
    selfPublicKey: new Uint8Array(32).fill(1),
    opponentPublicKey: new Uint8Array(32).fill(2),
    reads: {
      waitForTransaction: mock.fn(async () => ({})),
      getTransactionBlock: mock.fn(async () => ({ objectChanges: [] })),
      getObject: mock.fn(async () => ({})),
    },
  };

  it("openAndFundSeatA delegates to openAndFund override and returns tunnelId", async () => {
    const mockSignExec = mock.fn(async (_tx: unknown) => ({ digest: "digest-open" }));
    // Override bypasses the SDK's PACKAGE_ID requirement in tests.
    const mockOpenAndFund = mock.fn(async () => "0xtunnel1");

    const signer = makeTttSettlementSigner(mockSignExec, baseCtx, {
      openAndFund: mockOpenAndFund,
    });

    const result = await signer.openAndFundSeatA({ stake: 100n });
    assert.equal(result.tunnelId, "0xtunnel1");
    assert.equal(mockOpenAndFund.mock.calls.length, 1);
    // Verify the override received the correct stake
    const call = mockOpenAndFund.mock.calls[0].arguments[0] as { amount: bigint };
    assert.equal(call.amount, 100n);
  });

  it("openAndFundSeatA passes self/opponent party addresses from context", async () => {
    const mockSignExec = mock.fn(async (_tx: unknown) => ({ digest: "d" }));
    const mockOpenAndFund = mock.fn(async () => "0xtunnel2");

    const signer = makeTttSettlementSigner(mockSignExec, baseCtx, {
      openAndFund: mockOpenAndFund,
    });
    await signer.openAndFundSeatA({ stake: 50n });
    const call = mockOpenAndFund.mock.calls[0].arguments[0] as {
      partyA: { address: string };
      partyB: { address: string };
    };
    assert.equal(call.partyA.address, "0xwallet");
    assert.equal(call.partyB.address, "0xopponent");
  });

  it("depositSeatB delegates to deposit override", async () => {
    const mockSignExec = mock.fn(async (_tx: unknown) => ({ digest: "digest-dep" }));
    const mockDeposit = mock.fn(async () => {});

    const signer = makeTttSettlementSigner(mockSignExec, baseCtx, {
      deposit: mockDeposit,
    });

    await signer.depositSeatB({ tunnelId: "0xtunnel1", stake: 200n });
    assert.equal(mockDeposit.mock.calls.length, 1);
    const call = mockDeposit.mock.calls[0].arguments[0] as {
      tunnelId: string;
      amount: bigint;
    };
    assert.equal(call.tunnelId, "0xtunnel1");
    assert.equal(call.amount, 200n);
  });
});

// ── makeTttRelay ────────────────────────────────────────────────────────────

describe("makeTttRelay", () => {
  function makeStubRelayClient() {
    const appCbs: Record<string, ((m: Record<string, unknown>) => void)[]> = {};
    const hellos: Record<string, ((m: Record<string, unknown>) => void)[]> = {};
    const sentApp: { matchId: string; msg: Record<string, unknown> }[] = [];
    const sentTypes: { type: string; matchId?: string; [k: string]: unknown }[] = [];

    return {
      ready: Promise.resolve(),
      on: mock.fn((type: string, cb: (m: Record<string, unknown>) => void) => {
        if (type === "party.hello") {
          (hellos["party.hello"] ??= []).push(cb);
        }
      }),
      queueJoin: mock.fn((_game: string) => {}),
      partyHello: mock.fn((matchId: string, pubkeyHex: string, _sig: string) => {
        sentTypes.push({ type: "party.hello", matchId, pubkeyHex });
      }),
      tunnelOpened: mock.fn((matchId: string, tunnelId: string) => {
        sentTypes.push({ type: "tunnel.opened", matchId, tunnelId });
      }),
      sendApp: mock.fn((matchId: string, msg: Record<string, unknown>) => {
        sentApp.push({ matchId, msg });
        // Dispatch to registered onApp cb for this matchId
        (appCbs[matchId] ?? []).forEach((cb) => cb(msg));
      }),
      onApp: mock.fn((matchId: string, cb: (m: Record<string, unknown>) => void) => {
        (appCbs[matchId] ??= []).push(cb);
      }),
      transport: mock.fn((_matchId: string) => ({
        send: mock.fn(),
        onFrame: mock.fn(),
      })),
      close: mock.fn(),
      // helpers for test inspection
      _sentApp: sentApp,
      _sentTypes: sentTypes,
      _hellos: hellos,
    };
  }

  it("queueJoin awaits ready then delegates", async () => {
    const stub = makeStubRelayClient();
    const relay = makeTttRelay(stub as unknown as Parameters<typeof makeTttRelay>[0]);
    await relay.queueJoin("tictactoe:ttt");
    assert.equal(stub.queueJoin.mock.calls.length, 1);
    assert.equal(stub.queueJoin.mock.calls[0].arguments[0], "tictactoe:ttt");
  });

  it("channel.partyHello routes to relay.partyHello", () => {
    const stub = makeStubRelayClient();
    const relay = makeTttRelay(stub as unknown as Parameters<typeof makeTttRelay>[0]);
    const ch = relay.channel("match1");
    ch.partyHello("aabbcc");
    assert.equal(stub.partyHello.mock.calls.length, 1);
    assert.equal(stub.partyHello.mock.calls[0].arguments[0], "match1");
    assert.equal(stub.partyHello.mock.calls[0].arguments[1], "aabbcc");
  });

  it("channel.announceOpened routes to relay.tunnelOpened + sendApp {t:'opened'}", () => {
    const stub = makeStubRelayClient();
    const relay = makeTttRelay(stub as unknown as Parameters<typeof makeTttRelay>[0]);
    const ch = relay.channel("match1");
    ch.announceOpened("0xtun");
    assert.equal(stub.tunnelOpened.mock.calls.length, 1);
    assert.equal(stub.sendApp.mock.calls.length, 1);
    assert.equal(stub._sentApp[0].msg.t, "opened");
    assert.equal(stub._sentApp[0].msg.tunnelId, "0xtun");
  });

  it("channel.sendSettleHalf routes to sendApp {t:'settle'}", () => {
    const stub = makeStubRelayClient();
    const relay = makeTttRelay(stub as unknown as Parameters<typeof makeTttRelay>[0]);
    const ch = relay.channel("match1");
    ch.sendSettleHalf({ sig: "sigsig", root: "rootroot" });
    const msg = stub._sentApp[0].msg;
    assert.equal(msg.t, "settle");
    assert.equal(msg.sig, "sigsig");
    assert.equal(msg.root, "rootroot");
  });

  it("channel.onSettleHalf fires when sendApp delivers {t:'settle'}", async () => {
    const stub = makeStubRelayClient();
    const relay = makeTttRelay(stub as unknown as Parameters<typeof makeTttRelay>[0]);
    const ch = relay.channel("match1");

    // Register the handler first
    const received = await new Promise<{ sig: string; root: string }>((resolve) => {
      ch.onSettleHalf(resolve);
      // Simulate peer sending settle via sendApp routing
      stub.sendApp("match1", { t: "settle", sig: "s1", root: "r1" });
    });
    assert.equal(received.sig, "s1");
    assert.equal(received.root, "r1");
  });

  it("channel.onOpened fires when sendApp delivers {t:'opened'}", async () => {
    const stub = makeStubRelayClient();
    const relay = makeTttRelay(stub as unknown as Parameters<typeof makeTttRelay>[0]);
    const ch = relay.channel("match1");

    const tunnelId = await new Promise<string>((resolve) => {
      ch.onOpened(resolve);
      stub.sendApp("match1", { t: "opened", tunnelId: "0xtunX" });
    });
    assert.equal(tunnelId, "0xtunX");
  });

  it("channel.transport delegates to relay.transport", () => {
    const stub = makeStubRelayClient();
    const relay = makeTttRelay(stub as unknown as Parameters<typeof makeTttRelay>[0]);
    const ch = relay.channel("match1");
    // Access transport property — it should be the result of relay.transport(matchId)
    const t = ch.transport;
    assert.ok(t !== null && typeof t === "object");
    assert.equal(stub.transport.mock.calls.length, 1);
    assert.equal(stub.transport.mock.calls[0].arguments[0], "match1");
  });
});
