process.env.PACKAGE_ID = "0x" + "ab".repeat(32);

import assert from "node:assert/strict";
import { test } from "node:test";
import { CoSignedSettlement, CoSignedUpdate } from "../core/tunnel";
import { execute, makeRecoveryExecutor, sampleClose } from "./lifecycle";

const SAMPLE_UPDATE: CoSignedUpdate = {
  update: {
    tunnelId: "0x" + "cd".repeat(32),
    stateHash: new Uint8Array(32),
    nonce: 7n,
    timestamp: 100n,
    partyABalance: 300n,
    partyBBalance: 700n,
  },
  sigA: new Uint8Array(64),
  sigB: new Uint8Array(64),
};

/** Minimal fake SuiClient whose signAndExecuteTransaction reports a given on-chain status. */
function fakeClient(status: "success" | "failure") {
  return {
    signAndExecuteTransaction: async () => ({
      digest: "0xdeadbeef",
      effects: {
        status:
          status === "failure"
            ? { status: "failure", error: "MoveAbort(... , 5)" }
            : { status: "success" },
      },
      objectChanges: [],
    }),
    waitForTransaction: async () => ({}),
  } as unknown as Parameters<typeof execute>[0];
}

const noSigner = {} as unknown as Parameters<typeof execute>[1];
const emptyTx = {} as unknown as Parameters<typeof execute>[2];

test("REPRO #2: execute() throws when the transaction aborts on-chain (effects.status = failure)", async () => {
  await assert.rejects(
    () => execute(fakeClient("failure"), noSigner, emptyTx),
    /failed on-chain/,
  );
});

test("execute() resolves normally on success and returns the digest", async () => {
  const r = await execute(fakeClient("success"), noSigner, emptyTx);
  assert.equal(r.digest, "0xdeadbeef");
});

test("REPRO #10: raise_dispute executor with no latest update throws instead of disputing the stale current state", async () => {
  const exec = makeRecoveryExecutor(fakeClient("success"), {
    signerFor: () => noSigner as never,
    latestUpdate: () => null, // store not wired / no newer update available
    partyFor: () => "A",
    recipientFor: () => "0x0",
  });
  await assert.rejects(
    () => exec("t1", "raise_dispute"),
    /latest co-signed update/,
  );
});

test("raise_dispute_current_state executor still submits (explicitly chose current state)", async () => {
  let submitted = false;
  const client = {
    signAndExecuteTransaction: async () => {
      submitted = true;
      return {
        digest: "0x1",
        effects: { status: { status: "success" } },
        objectChanges: [],
      };
    },
  } as unknown as Parameters<typeof execute>[0];
  const exec = makeRecoveryExecutor(client, {
    signerFor: () => noSigner as never,
    latestUpdate: () => null,
    partyFor: () => "A",
    recipientFor: () => "0x0",
  });
  await exec("t1", "raise_dispute_current_state");
  assert.ok(submitted);
});

test("resolve_dispute executor submits the latest dual-signed state (REPRO #1, executor wiring)", async () => {
  let submitted = false;
  const client = {
    signAndExecuteTransaction: async () => {
      submitted = true;
      return {
        digest: "0x2",
        effects: { status: { status: "success" } },
        objectChanges: [],
      };
    },
  } as unknown as Parameters<typeof execute>[0];
  const exec = makeRecoveryExecutor(client, {
    signerFor: () => noSigner as never,
    latestUpdate: () => SAMPLE_UPDATE,
    partyFor: () => "B",
    recipientFor: () => "0x0",
  });
  await exec("t1", "resolve_dispute");
  assert.ok(submitted, "resolve_dispute must build and submit a tx");
});

test("resolve_dispute executor with no latest update throws (no silent no-op)", async () => {
  const exec = makeRecoveryExecutor(fakeClient("success"), {
    signerFor: () => noSigner as never,
    latestUpdate: () => null,
    partyFor: () => "B",
    recipientFor: () => "0x0",
  });
  await assert.rejects(
    () => exec("t1", "resolve_dispute"),
    /latest co-signed update/,
  );
});

const SAMPLE_SETTLEMENT: CoSignedSettlement = {
  settlement: {
    tunnelId: "0x" + "cd".repeat(32),
    partyABalance: 1n,
    partyBBalance: 1n,
    finalNonce: 1n,
    timestamp: 1n,
  },
  sigA: new Uint8Array(64),
  sigB: new Uint8Array(64),
};

test("REPRO #12: sampleClose round-robins a signer pool (independent gas coins) and submits all closes", async () => {
  const used: string[] = [];
  const client = {
    signAndExecuteTransaction: async ({
      signer,
    }: {
      signer: { id: string };
    }) => {
      used.push(signer.id);
      return {
        digest: "0x" + used.length,
        effects: { status: { status: "success" } },
        objectChanges: [],
      };
    },
  } as unknown as Parameters<typeof execute>[0];
  const signers = [
    { id: "s0" },
    { id: "s1" },
    { id: "s2" },
  ] as unknown as Parameters<typeof sampleClose>[6];
  const tunnels = Array.from({ length: 6 }, () => ({
    tunnelId: "0x" + "cd".repeat(32),
    settlement: SAMPLE_SETTLEMENT,
  }));
  const digests = await sampleClose(
    client,
    signers![0] as never,
    tunnels,
    6,
    {},
    undefined,
    signers,
  );
  assert.equal(digests.length, 6);
  assert.deepEqual(used, ["s0", "s1", "s2", "s0", "s1", "s2"]); // round-robin, not one signer
});

test("sampleClose with a single signer stays serial (backward compatible)", async () => {
  const used: string[] = [];
  const client = {
    signAndExecuteTransaction: async () => {
      used.push("solo");
      return {
        digest: "0x" + used.length,
        effects: { status: { status: "success" } },
        objectChanges: [],
      };
    },
  } as unknown as Parameters<typeof execute>[0];
  const tunnels = Array.from({ length: 3 }, () => ({
    tunnelId: "0x" + "cd".repeat(32),
    settlement: SAMPLE_SETTLEMENT,
  }));
  const digests = await sampleClose(client, noSigner as never, tunnels, 3);
  assert.equal(digests.length, 3);
});
