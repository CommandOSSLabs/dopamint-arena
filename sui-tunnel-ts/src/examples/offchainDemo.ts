/**
 * End-to-end off-chain framework demo (no chain required). Shows the whole pipeline:
 * agents → tunnels → signed interactions → telemetry → proof-of-existence root → settle.
 *
 *   node --import tsx src/examples/offchainDemo.ts
 *   node dist/examples/offchainDemo.js
 *
 * Covers Deliverables 1, 2, 5, 6, 7, 9 in one screen (Deliverable 10 = src/bench/cli.ts).
 */

import { AgentSwarm } from "../agents/Agent";
import { toHex } from "../core/bytes";
import { verify } from "../core/crypto";
import { serializeSettlementWithRoot } from "../core/wire";
import { Transcript } from "../proof/transcript";
import { reportToJSON } from "../telemetry/export";
import { rateReport } from "../telemetry/metrics";

export function runOffchainDemo(): void {
  // 1. A swarm of autonomous agents across all five protocols, matchmade into tunnels.
  const swarm = new AgentSwarm({ agents: 50, tunnels: 200, seed: 42 });
  console.log("behavior breakdown:", swarm.behaviorBreakdown());

  // 2. Attach a proof-of-existence transcript to one tunnel (D7).
  const tracked = swarm.tunnels[0];
  const transcript = new Transcript(tracked.tunnelId);
  tracked.onUpdate = (u) => transcript.append(u);

  // 3. Drive signed, mutually-verified interactions (D1/D5) with telemetry (D6).
  const gen = swarm.activityGenerator("full");
  const t0 = Date.now();
  gen.runSteps(20_000);
  const elapsed = Date.now() - t0;
  const report = rateReport(swarm.counters, elapsed);
  console.log("\ntelemetry (JSON):");
  console.log(reportToJSON(report));

  // 4. Proof-of-existence: the transcript Merkle root anchors the tracked tunnel's history.
  const root = transcript.root();
  console.log(
    `\ntranscript for ${tracked.tunnelId}: ${transcript.length} updates`
  );
  console.log(`transcript root (anchored on-chain at close): 0x${toHex(root)}`);

  // 5. Settlement compression: root-anchored cooperative settlement (D8), verified locally.
  const settle = tracked.buildSettlementWithRoot(BigInt(Date.now()), root);
  const msg = serializeSettlementWithRoot(settle.settlement);
  const ok =
    verify(settle.sigA, msg, tracked.partyA.publicKey) &&
    verify(settle.sigB, msg, tracked.partyB.publicKey);
  console.log(`root-anchored settlement signatures verify: ${ok}`);

  // 6. Auto-settle the whole swarm and report settleability (D9 lifecycle).
  swarm.settleAll(BigInt(Date.now()));
  console.log(
    `settlement success across ${swarm.tunnels.length} tunnels: ` +
      `${(swarm.settlementSuccessRate() * 100).toFixed(1)}%`
  );
}

if (require.main === module) {
  runOffchainDemo();
}
