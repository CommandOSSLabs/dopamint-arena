import { describe, it } from "node:test";
import assert from "node:assert";
import { linkedLoopback } from "./loopbackTransport";

describe("linkedLoopback", () => {
  it("delivers a frame sent on A to B's onFrame handler", () => {
    const { a, b } = linkedLoopback();
    const received: number[][] = [];
    b.onFrame((f) => received.push([...f]));
    a.send(Uint8Array.of(1, 2, 3));
    assert.deepStrictEqual(received, [[1, 2, 3]]);
  });

  it("fires onClose on both ends when either closes", () => {
    const { a, b } = linkedLoopback();
    let aClosed = false;
    let bClosed = false;
    a.onClose(() => (aClosed = true));
    b.onClose(() => (bClosed = true));
    a.close();
    assert.strictEqual(aClosed, true);
    assert.strictEqual(bClosed, true);
  });
});
