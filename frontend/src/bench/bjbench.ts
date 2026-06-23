/**
 * Real-blackjack full-flow driver (parity + throughput), the JS counterpart to
 * the Rust port in ./rust-blackjack. Uses the REAL BlackjackBetProtocol + kit bot
 * + OffchainTunnel with FIXED keys, so a `parity` run is byte-reproducible against
 * Rust (same stateHash + signatures). Bundle with esbuild, then run under node/bun.
 *   parity: bun dist/bench/bjbench.js parity
 *   bench : bun dist/bench/bjbench.js bench 10000
 */
import { GAME_KITS, type Party } from "@/agent/gameKit";
import { actorFor } from "@/games/blackjack/app/lib/bjBetProtocol";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { keyPairFromSecret, ed25519Address } from "sui-tunnel-ts/core/crypto";
import { nativeBackend } from "sui-tunnel-ts/core/crypto-native";
import { toHex } from "sui-tunnel-ts/core/bytes";

const RT = "bun" in process.versions ? `bun-${process.versions.bun}` : `node-${process.version}`;
const kit = GAME_KITS["blackjack"];
const keyA = keyPairFromSecret(new Uint8Array(32).fill(3));
const keyB = keyPairFromSecret(new Uint8Array(32).fill(4));
const addrA = ed25519Address(keyA.publicKey);
const addrB = ed25519Address(keyB.publicKey);
const tid = "0x" + "11".repeat(32);
const ctx = { rngForSeat: () => () => 0.5 };

function open() {
  const tunnel = OffchainTunnel.selfPlay(kit.protocol, tid, keyA, keyB, addrA, addrB, { a: 10000n, b: 10000n }, nativeBackend);
  return { tunnel, botA: kit.createBot("A", ctx), botB: kit.createBot("B", ctx) };
}

const mode = process.argv[2] ?? "bench";
if (mode === "parity") {
  const { tunnel, botA, botB } = open();
  let steps = 0;
  while (steps < 50 && !kit.protocol.isTerminal(tunnel.state)) {
    const actor = actorFor(tunnel.state) as Party;
    const move = (actor === "A" ? botA : botB).plan(tunnel.state);
    if (move === null) break;
    tunnel.step(move, actor, { mode: "full" });
    steps++;
  }
  const u = tunnel.latest!;
  console.log(`PARITY steps=${steps} sh=${toHex(u.update.stateHash).slice(0, 16)} sigA=${toHex(u.sigA).slice(0, 16)} sigB=${toHex(u.sigB).slice(0, 16)}`);
} else {
  const durMs = Number(process.argv[3] ?? 6000);
  const run = (dur: number) => {
    let slot = open();
    let steps = 0;
    const t = Date.now();
    while (Date.now() - t < dur) {
      if (kit.protocol.isTerminal(slot.tunnel.state)) { slot = open(); continue; }
      const h = kit.stateHash(slot.tunnel.state); // dedup hash (harness)
      void h;
      const actor = actorFor(slot.tunnel.state) as Party;
      const move = (actor === "A" ? slot.botA : slot.botB).plan(slot.tunnel.state);
      if (move === null) { slot = open(); continue; }
      slot.tunnel.step(move, actor, { mode: "full" });
      steps++;
    }
    return steps;
  };
  run(1500);
  const steps = run(durMs);
  console.log(`[${RT}] blackjack full-flow: ${Math.round(steps / (durMs / 1000)).toLocaleString()} transitions/s`);
}
