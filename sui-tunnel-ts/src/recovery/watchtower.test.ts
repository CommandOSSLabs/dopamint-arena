import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideRecovery,
  RecoveryAction,
  TunnelLiveness,
  Watchtower,
} from "./watchtower";

const base: TunnelLiveness = {
  status: 1, // ACTIVE
  iAmDisputeRaiser: false,
  hasCounterpartySignedNewerState: true,
  createdAtMs: 0,
  lastActivityMs: 0,
  timeoutMs: 10_000,
  nowMs: 0,
  counterpartyDeposited: true,
  heartbeatTimeoutMs: 5_000,
};

test("active + counterparty silent + newer state => raise_dispute", () => {
  assert.equal(decideRecovery({ ...base, nowMs: 6_000 }), "raise_dispute");
});

test("active + counterparty silent + no newer state => raise_dispute_current_state", () => {
  assert.equal(
    decideRecovery({
      ...base,
      nowMs: 6_000,
      hasCounterpartySignedNewerState: false,
    }),
    "raise_dispute_current_state"
  );
});

test("active + recent activity => none", () => {
  assert.equal(decideRecovery({ ...base, nowMs: 1_000 }), "none");
});

test("created + counterparty never deposited + past timeout => withdraw_timeout", () => {
  assert.equal(
    decideRecovery({
      ...base,
      status: 0,
      counterpartyDeposited: false,
      nowMs: 11_000,
    }),
    "withdraw_timeout"
  );
});

test("created + within timeout => none", () => {
  assert.equal(
    decideRecovery({
      ...base,
      status: 0,
      counterpartyDeposited: false,
      nowMs: 5_000,
    }),
    "none"
  );
});

test("disputed + I am raiser + deadline passed => force_close", () => {
  assert.equal(
    decideRecovery({
      ...base,
      status: 3,
      iAmDisputeRaiser: true,
      disputeStartMs: 0,
      nowMs: 11_000,
    }),
    "force_close"
  );
});

test("disputed + not raiser + no newer state => none (nothing better to submit)", () => {
  assert.equal(
    decideRecovery({
      ...base,
      status: 3,
      iAmDisputeRaiser: false,
      hasCounterpartySignedNewerState: false,
      nowMs: 99_999,
    }),
    "none"
  );
});

test("closed/destroyed => none", () => {
  assert.equal(decideRecovery({ ...base, status: 2 }), "none");
  assert.equal(decideRecovery({ ...base, status: 4 }), "none");
});

test("Watchtower.tick executes the decided action and stops watching after terminal recovery", async () => {
  const actions: { id: string; action: RecoveryAction }[] = [];
  const executed: string[] = [];
  const wt = new Watchtower(
    async (id, action) => {
      executed.push(`${id}:${action}`);
    },
    { onAction: (id, action) => actions.push({ id, action }) }
  );
  wt.watch({
    tunnelId: "t1",
    fetchLiveness: () => ({
      ...base,
      status: 0,
      counterpartyDeposited: false,
      nowMs: 11_000,
    }),
  });
  assert.equal(wt.size, 1);
  await wt.tick();
  assert.deepEqual(executed, ["t1:withdraw_timeout"]);
  assert.equal(wt.size, 0); // terminal recovery -> unwatched
});

test("REPRO #1: disputed + not raiser + we hold a newer co-signed state => resolve_dispute", () => {
  // A malicious counterparty raised a dispute with a STALE (older) state. We hold a
  // newer co-signed state. The watchtower MUST submit resolve_dispute to override it,
  // or after the timeout the counterparty force-closes on the stale state and we lose funds.
  assert.equal(
    decideRecovery({
      ...base,
      status: 3, // DISPUTED
      iAmDisputeRaiser: false,
      hasCounterpartySignedNewerState: true,
      nowMs: 99_999,
    }),
    "resolve_dispute"
  );
});

test("REPRO #2 (watchtower side): a failed terminal-recovery submission keeps the tunnel watched", async () => {
  // If execute() rejects (because the tx aborted on-chain), tick() must NOT unwatch the
  // tunnel — recovery has to be retried. This only holds end-to-end if execute() throws
  // on an on-chain failure (see lifecycle.test.ts REPRO #2).
  const errs: string[] = [];
  const wt = new Watchtower(
    async () => {
      throw new Error("on-chain abort");
    },
    { onError: (id) => errs.push(id) }
  );
  wt.watch({
    tunnelId: "t-fail",
    fetchLiveness: () => ({
      ...base,
      status: 0,
      counterpartyDeposited: false,
      nowMs: 11_000,
    }),
  });
  await wt.tick();
  assert.equal(wt.size, 1); // NOT unwatched, because the executor threw
  assert.deepEqual(errs, ["t-fail"]);
});

test("Watchtower.tick is a no-op when no action is needed", async () => {
  const executed: string[] = [];
  const wt = new Watchtower(
    async (id, action) => void executed.push(`${id}:${action}`)
  );
  wt.watch({
    tunnelId: "t2",
    fetchLiveness: () => ({ ...base, nowMs: 1_000 }),
  });
  await wt.tick();
  assert.equal(executed.length, 0);
  assert.equal(wt.size, 1);
});
