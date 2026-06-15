import assert from "node:assert/strict";
import { test } from "node:test";
import { verify } from "../core/crypto";
import { serializeSettlement } from "../core/wire";
import { Agent, AgentSwarm, Matchmaker } from "./Agent";
import {
  BEHAVIOR_NAMES,
  createBehaviorProtocol,
  parseBehaviors,
} from "./behaviors";

test("every behavior maps to a usable protocol", () => {
  for (const b of BEHAVIOR_NAMES) {
    const p = createBehaviorProtocol(b);
    assert.ok(p.name.length > 0);
  }
  assert.deepEqual(parseBehaviors("payment,poker"), ["payment", "poker"]);
  assert.throws(() => parseBehaviors("nope"));
});

test("Matchmaker pairs distinct agents", () => {
  const agents: Agent[] = Array.from({ length: 6 }, (_, i) => ({
    id: `a${i}`,
    participant: { id: `a${i}`, address: `0x${i}`, keyPair: {} as never },
    behaviors: ["payment"],
  }));
  const pairs = Matchmaker.pair(agents, 10, ["payment"]);
  assert.equal(pairs.length, 10);
  for (const p of pairs) assert.notEqual(p.a.id, p.b.id);
});

test("REPRO #8: Matchmaker.pair never self-pairs with exactly 2 agents", () => {
  const agents: Agent[] = Array.from({ length: 2 }, (_, i) => ({
    id: `a${i}`,
    participant: { id: `a${i}`, address: `0x${i}`, keyPair: {} as never },
    behaviors: ["payment"],
  }));
  const pairs = Matchmaker.pair(agents, 4, ["payment"]);
  assert.equal(pairs.length, 4);
  // previously i=2,3 produced a0/a0 and a1/a1 (single shared keypair playing itself)
  for (const p of pairs) assert.notEqual(p.a.id, p.b.id);
});

test("AgentSwarm builds mixed-behavior tunnels and drives interactions", () => {
  const swarm = new AgentSwarm({ agents: 10, tunnels: 20, seed: 7 });
  assert.equal(swarm.tunnels.length, 20);
  assert.equal(swarm.agents.length, 10);
  const breakdown = swarm.behaviorBreakdown();
  // all five behaviors represented across 20 tunnels
  assert.equal(Object.keys(breakdown).length, BEHAVIOR_NAMES.length);

  swarm.activityGenerator("full").runSteps(2000);
  assert.ok(swarm.counters.updates > 0);
  // every tunnel's latest co-signed state is independently settleable
  assert.equal(swarm.settlementSuccessRate(), 1);
});

test("settleAll produces cooperative settlements that verify", () => {
  const swarm = new AgentSwarm({
    agents: 4,
    tunnels: 4,
    behaviors: ["payment"],
    seed: 3,
  });
  swarm.activityGenerator("full").runSteps(400);
  const settlements = swarm.settleAll(1234567890n);
  assert.equal(settlements.length, 4);
  for (let i = 0; i < settlements.length; i++) {
    const { settlement } = settlements[i];
    const t = swarm.tunnels[i];
    const msg = serializeSettlement(settlement.settlement);
    assert.ok(verify(settlement.sigA, msg, t.partyA.publicKey));
    assert.ok(verify(settlement.sigB, msg, t.partyB.publicKey));
  }
  assert.equal(swarm.counters.settlements, 4);
});
