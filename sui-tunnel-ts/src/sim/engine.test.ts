import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyCoSignedUpdate } from "../core/tunnel";
import { simTunnelId, Simulator, TunnelKind } from "./engine";

test("simulator builds the requested number of tunnels with unique ids", () => {
  const sim = new Simulator({ users: 10, agents: 10, tunnels: 25 });
  assert.equal(sim.tunnels.length, 25);
  assert.equal(sim.users.length, 10);
  assert.equal(sim.agents.length, 10);
  const ids = new Set(sim.tunnels.map((t) => t.tunnelId));
  assert.equal(ids.size, 25);
  assert.equal(sim.tunnels[0].tunnelId, simTunnelId(0));
  assert.equal(sim.counters.tunnelsOpened, 25);
});

test("all four tunnel kinds build signable tunnels", () => {
  const kinds: TunnelKind[] = [
    "user-user",
    "user-agent",
    "agent-agent",
    "self-play",
  ];
  const sim = new Simulator({ users: 4, agents: 4, tunnels: 8, kinds });
  const gen = sim.activityGenerator("full");
  gen.runSteps(80);
  for (const t of sim.tunnels) {
    const u = t.latest;
    assert.ok(u, "tunnel should have a co-signed update");
    assert.ok(
      verifyCoSignedUpdate(
        u!,
        { publicKey: t.partyA.publicKey, scheme: t.partyA.scheme },
        { publicKey: t.partyB.publicKey, scheme: t.partyB.scheme },
      ),
    );
  }
});

test("deterministic assignment is reproducible across runs", () => {
  const a = new Simulator({ users: 5, agents: 5, tunnels: 10, seed: 42 });
  const b = new Simulator({ users: 5, agents: 5, tunnels: 10, seed: 42 });
  for (let i = 0; i < 10; i++) {
    assert.equal(a.tunnels[i].partyA.address, b.tunnels[i].partyA.address);
  }
});

test("balances stay conserved through a run", () => {
  const sim = new Simulator({
    users: 3,
    agents: 3,
    tunnels: 6,
    initialBalance: 500_000n,
  });
  sim.activityGenerator("full").runSteps(600);
  for (const t of sim.tunnels) {
    const b = t.protocol.balances(t.state);
    assert.equal(b.a + b.b, 1_000_000n);
  }
});
