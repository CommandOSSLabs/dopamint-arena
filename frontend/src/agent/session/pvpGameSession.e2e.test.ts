import { describe, it } from "node:test";
import assert from "node:assert";
import { core } from "sui-tunnel-ts";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { GAME_KITS } from "@/agent/gameKit";
import { linkedLoopback } from "./loopbackTransport";
import { PvpGameSession } from "./pvpGameSession";

// Deterministic per-seat RNG factory: mulberry32 seeded per seat via a closure.
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

describe("PvpGameSession (two-endpoint loopback)", () => {
  it("drives ttt to terminal; both seats agree on the transcript root", async () => {
    const kit = GAME_KITS["tictactoe"];
    const { a: txA, b: txB } = linkedLoopback();
    const keyA = core.generateKeyPair();
    const keyB = core.generateKeyPair();
    // tunnelId must be a valid 0x-prefixed 32-byte hex string (wire format requirement).
    const ctx = {
      tunnelId: "0x" + "ab".repeat(32),
      initialBalances: { a: 100n, b: 100n },
    };
    const backend = defaultBackend();

    const dtA = new core.DistributedTunnel(
      kit.protocol as never,
      {
        tunnelId: ctx.tunnelId,
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
      ctx.initialBalances,
    );

    const dtB = new core.DistributedTunnel(
      kit.protocol as never,
      {
        tunnelId: ctx.tunnelId,
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
      ctx.initialBalances,
    );

    const sA = new PvpGameSession(kit, "A", { rngForSeat: seeded(1) });
    const sB = new PvpGameSession(kit, "B", { rngForSeat: seeded(2) });
    sA.attachTunnel({
      tunnel: dtA as never,
      initialState: kit.protocol.initialState(ctx),
    });
    sB.attachTunnel({
      tunnel: dtB as never,
      initialState: kit.protocol.initialState(ctx),
    });
    sA.setAuto(true);
    sB.setAuto(true);

    sA.kickoff();
    await waitFor(() => sA.getSnapshot().terminal && sB.getSnapshot().terminal);

    const bal = sA.getSnapshot().balances!;
    assert.strictEqual(bal.a + bal.b, 200n, "balances conserved");
    assert.strictEqual(
      sA.transcriptRootHex(),
      sB.transcriptRootHex(),
      "both seats must derive the same transcript root",
    );
  });
});

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const i = setInterval(() => {
      if (predicate()) {
        clearInterval(i);
        res();
      } else if (Date.now() - t0 > 5000) {
        clearInterval(i);
        rej(
          new Error(
            "waitFor timeout: game did not reach terminal state within 5s",
          ),
        );
      }
    }, 1);
  });
}
