import { describe, it } from "node:test";
import assert from "node:assert";
import { SnapshotStore } from "./snapshotStore";

describe("SnapshotStore", () => {
  it("returns a stable reference until a real change", () => {
    const store = new SnapshotStore({ phase: "idle", n: 0 });
    const first = store.get();
    store.set({ phase: "idle", n: 0 }); // structurally identical
    assert.strictEqual(
      store.get(),
      first,
      "no-op set must not change the reference",
    );
    store.set({ phase: "idle", n: 1 });
    assert.notStrictEqual(store.get(), first);
  });

  it("notifies subscribers only on a real change and the snapshot is frozen", () => {
    const store = new SnapshotStore({ phase: "idle", n: 0 });
    let calls = 0;
    store.subscribe(() => calls++);
    store.set({ phase: "idle", n: 0 });
    store.set({ phase: "idle", n: 1 });
    assert.strictEqual(calls, 1);
    assert.strictEqual(Object.isFrozen(store.get()), true);
  });
});
