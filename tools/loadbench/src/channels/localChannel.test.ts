import { test, expect } from "bun:test";
import { pairLocalChannel } from "./localChannel";

test("frames sent on A arrive on B and vice-versa", async () => {
  const [a, b] = pairLocalChannel();
  const gotB: string[] = [];
  const gotA: string[] = [];
  b.onFrame((f) => gotB.push(new TextDecoder().decode(f)));
  a.onFrame((f) => gotA.push(new TextDecoder().decode(f)));
  a.send(new TextEncoder().encode("a->b"));
  b.send(new TextEncoder().encode("b->a"));
  await Promise.resolve();
  await new Promise((r) => queueMicrotask(() => r(null)));
  expect(gotB).toEqual(["a->b"]);
  expect(gotA).toEqual(["b->a"]);
});
