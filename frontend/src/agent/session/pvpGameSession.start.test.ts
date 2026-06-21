import { describe, it } from "node:test";
import assert from "node:assert";
import { core } from "sui-tunnel-ts";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { GAME_KITS } from "@/agent/gameKit";
import { linkedLoopback } from "./loopbackTransport";
import { PvpGameSession } from "./pvpGameSession";
import type {
  SessionRelay,
  MatchChannel,
  MatchFound,
  SessionTransport,
  PartyEndpointFactory,
  SettlementSigner,
} from "./seams";

// ---------------------------------------------------------------------------
// Fake relay pair
//
// FakeRelayPair wires two sessions together in-process.  Each side's
// queueJoin() enqueues itself; once both seats have joined, the pair fires
// onMatch on both sides simultaneously with complementary roles (A / B).
// The per-match channel uses a linkedLoopback for the frame transport and
// plain callbacks with a one-element buffer for partyHello / onOpened.
// ---------------------------------------------------------------------------

function makeFakeRelayPair(): { relayA: SessionRelay; relayB: SessionRelay } {
  // Shared match state
  let matchId = "fake-match-" + Math.random().toString(36).slice(2);
  const walletA = "0xAAAA";
  const walletB = "0xBBBB";

  const { a: txA, b: txB } = linkedLoopback();

  // Each channel buffers one hello and one opened event.
  function makeChannel(
    transport: SessionTransport,
  ): MatchChannel & { _deliver(event: string, val: string): void } {
    let helloCb: ((pubkeyHex: string) => void) | null = null;
    let helloBuffer: string | null = null;
    let openedCb: ((tunnelId: string) => void) | null = null;
    let openedBuffer: string | null = null;

    const ch = {
      transport,
      partyHello(_pubkeyHex: string) {
        /* side-channelled via _deliver */
      },
      onPeerHello(cb: (pubkeyHex: string) => void) {
        if (helloBuffer !== null) {
          cb(helloBuffer);
          helloBuffer = null;
        } else helloCb = cb;
      },
      announceOpened(_tunnelId: string) {
        /* side-channelled via _deliver */
      },
      onOpened(cb: (tunnelId: string) => void) {
        if (openedBuffer !== null) {
          cb(openedBuffer);
          openedBuffer = null;
        } else openedCb = cb;
      },
      _deliver(event: string, val: string) {
        if (event === "hello") {
          if (helloCb) {
            helloCb(val);
            helloCb = null;
          } else helloBuffer = val;
        } else if (event === "opened") {
          if (openedCb) {
            openedCb(val);
            openedCb = null;
          } else openedBuffer = val;
        }
      },
    };
    return ch;
  }

  const chA = makeChannel(txA);
  const chB = makeChannel(txB);

  // Cross-wire: when A calls partyHello it delivers to B's peer-hello listener and vice versa.
  // Patch after both channels are created.
  chA.partyHello = (hex: string) => chB._deliver("hello", hex);
  chB.partyHello = (hex: string) => chA._deliver("hello", hex);
  chA.announceOpened = (tunnelId: string) => chB._deliver("opened", tunnelId);
  // B never calls announceOpened in the handshake but wire it anyway for completeness.
  chB.announceOpened = (tunnelId: string) => chA._deliver("opened", tunnelId);

  // Relay state machine
  let matchCbA: ((m: MatchFound) => void) | null = null;
  let matchCbB: ((m: MatchFound) => void) | null = null;
  let aQueued = false;
  let bQueued = false;

  function tryFire() {
    if (aQueued && bQueued && matchCbA && matchCbB) {
      const cbA = matchCbA;
      const cbB = matchCbB;
      // fire in separate micro-tasks so neither blocks the other
      Promise.resolve().then(() =>
        cbA({ matchId, role: "A", opponentWallet: walletB }),
      );
      Promise.resolve().then(() =>
        cbB({ matchId, role: "B", opponentWallet: walletA }),
      );
    }
  }

  const relayA: SessionRelay = {
    async queueJoin(_game: string) {
      aQueued = true;
      tryFire();
    },
    onMatch(cb) {
      matchCbA = cb;
      tryFire();
    },
    channel(_matchId: string) {
      return chA;
    },
  };

  const relayB: SessionRelay = {
    async queueJoin(_game: string) {
      bQueued = true;
      tryFire();
    },
    onMatch(cb) {
      matchCbB = cb;
      tryFire();
    },
    channel(_matchId: string) {
      return chB;
    },
  };

  return { relayA, relayB };
}

// ---------------------------------------------------------------------------
// Fake SettlementSigner + PartyEndpointFactory
// ---------------------------------------------------------------------------

const FIXED_TUNNEL_ID = "0x" + "cd".repeat(32);

function makeFakeSettlementSigner(): SettlementSigner {
  return {
    async openAndFundSeatA(_args) {
      return { tunnelId: FIXED_TUNNEL_ID };
    },
    async depositSeatB(_args) {
      // no-op
    },
    async submitCooperativeClose(_args) {
      return { digest: "0xdeadbeef" };
    },
    async closeOnTimeout(_args) {
      return { digest: "0xdeadbeef" };
    },
  };
}

function makeFakeEndpointFactory(
  keyPair: { publicKey: Uint8Array; scheme: number; secretKey?: Uint8Array },
  address: string,
): PartyEndpointFactory {
  const backend = defaultBackend();
  return {
    self() {
      return { publicKey: keyPair.publicKey };
    },
    buildConfig(args) {
      return {
        tunnelId: args.tunnelId,
        selfParty: args.selfParty,
        self: core.makeEndpoint(backend, address, keyPair, true),
        opponent: core.makeEndpoint(
          backend,
          args.opponentAddress,
          { publicKey: args.opponentPublicKey, scheme: 0 },
          false,
        ),
      };
    },
  };
}

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
// Tests
// ---------------------------------------------------------------------------

describe("PvpGameSession start() handshake", () => {
  it("both sessions reach phase 'playing' sharing the same tunnelId", async () => {
    const kit = GAME_KITS["tictactoe"];
    const keyA = core.generateKeyPair();
    const keyB = core.generateKeyPair();

    const { relayA, relayB } = makeFakeRelayPair();

    const sA = new PvpGameSession(
      kit,
      "A",
      { rngForSeat: seeded(1) },
      {
        relay: relayA,
        endpointFactory: makeFakeEndpointFactory(keyA, "0xAAAA"),
        settlementSigner: makeFakeSettlementSigner(),
      },
    );
    const sB = new PvpGameSession(
      kit,
      "B",
      { rngForSeat: seeded(2) },
      {
        relay: relayB,
        endpointFactory: makeFakeEndpointFactory(keyB, "0xBBBB"),
        settlementSigner: makeFakeSettlementSigner(),
      },
    );

    assert.strictEqual(sA.getSnapshot().phase, "idle");
    assert.strictEqual(sB.getSnapshot().phase, "idle");

    // start() resolves once the session reaches "playing"
    const doneA = sA.start({ game: "tictactoe", stake: 100n });
    const doneB = sB.start({ game: "tictactoe", stake: 100n });

    await Promise.all([doneA, doneB]);

    assert.strictEqual(
      sA.getSnapshot().phase,
      "playing",
      "sA must reach playing",
    );
    assert.strictEqual(
      sB.getSnapshot().phase,
      "playing",
      "sB must reach playing",
    );
    assert.strictEqual(sA.getSnapshot().error, null, "sA must have no error");
    assert.strictEqual(sB.getSnapshot().error, null, "sB must have no error");
  });

  it("drives ttt to terminal after start() completes", async () => {
    const kit = GAME_KITS["tictactoe"];
    const keyA = core.generateKeyPair();
    const keyB = core.generateKeyPair();

    const { relayA, relayB } = makeFakeRelayPair();

    const sA = new PvpGameSession(
      kit,
      "A",
      { rngForSeat: seeded(3) },
      {
        relay: relayA,
        endpointFactory: makeFakeEndpointFactory(keyA, "0xAAAA"),
        settlementSigner: makeFakeSettlementSigner(),
      },
    );
    const sB = new PvpGameSession(
      kit,
      "B",
      { rngForSeat: seeded(4) },
      {
        relay: relayB,
        endpointFactory: makeFakeEndpointFactory(keyB, "0xBBBB"),
        settlementSigner: makeFakeSettlementSigner(),
      },
    );

    sA.setAuto(true);
    sB.setAuto(true);

    await Promise.all([
      sA.start({ game: "tictactoe", stake: 100n }),
      sB.start({ game: "tictactoe", stake: 100n }),
    ]);

    sA.kickoff();

    await waitFor(() => sA.getSnapshot().terminal && sB.getSnapshot().terminal);

    const bal = sA.getSnapshot().balances!;
    assert.strictEqual(bal.a + bal.b, 200n, "balances conserved");
  });
});
