/**
 * Solo self-play spec parity: the worker solo wall now runs over the PvP protocol, so its view is
 * the SAME ordered PvpCell[] render stream the online board consumes — not a 20×20 grid. This pins
 * the two properties the rich renderer relies on: cells accumulate in monotonic global seq order,
 * and both bot seats (A and B) actually paint (a lopsided wall would look broken).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { worldCanvasSoloSpec } from "./worldCanvasSoloSpec";
import type { PvpCell } from "sui-tunnel-ts/protocol/worldCanvasPvp";

/** A minimal fake tunnel that drives the spec's protocol like OffchainTunnel.selfPlay would. */
function makeFakeTunnel() {
  const proto = worldCanvasSoloSpec.makeProtocol("0xtest", 1n);
  let state = proto.initialState({ initialBalances: { a: 1n, b: 1n } });
  return {
    proto,
    get state() {
      return state;
    },
    step(move: unknown, by: "A" | "B") {
      state = proto.applyMove(state, move, by);
    },
  };
}

test("solo view is a growing PvpCell[] with monotonic seq", () => {
  const tunnel = makeFakeTunnel();
  for (let i = 0; i < 20; i++) {
    worldCanvasSoloSpec.stepWith(tunnel.proto, tunnel, {}, null);
  }
  const view = worldCanvasSoloSpec.deriveView(tunnel.state) as PvpCell[];
  assert.ok(view.length > 0, "expected painted cells");
  for (let i = 1; i < view.length; i++) {
    assert.ok(view[i].seq > view[i - 1].seq, "seq must be strictly increasing");
  }
});

test("both bot seats paint (alternating turns)", () => {
  const tunnel = makeFakeTunnel();
  for (let i = 0; i < 20; i++) {
    worldCanvasSoloSpec.stepWith(tunnel.proto, tunnel, {}, null);
  }
  const view = worldCanvasSoloSpec.deriveView(tunnel.state) as PvpCell[];
  assert.ok(
    view.some((c) => c.by === "A"),
    "seat A must paint",
  );
  assert.ok(
    view.some((c) => c.by === "B"),
    "seat B must paint",
  );
});

test("take-the-wheel: a queued seat-A run is co-signed on A's turn", () => {
  const tunnel = makeFakeTunnel();
  const humanMove = {
    cells: [{ cx: 0, cy: 0, x: 5, y: 5, color: 3, seq: 1 }],
  };
  let taken = false;
  const take = () => {
    if (taken) return undefined;
    taken = true;
    return humanMove;
  };
  // Turn starts at "A"; the queued human run should fold at cell (5,5) color 3.
  worldCanvasSoloSpec.stepWith(tunnel.proto, tunnel, {}, take);
  const view = worldCanvasSoloSpec.deriveView(tunnel.state) as PvpCell[];
  assert.ok(
    view.some((c) => c.by === "A" && c.gx === 5 && c.gy === 5 && c.color === 3),
    "human seat-A cell must be present",
  );
});
