import { test, expect } from "bun:test";
import { waitHealthy } from "./relayProcess";

test("waitHealthy resolves once health returns ok", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return { ok: calls >= 3 } as Response; }) as unknown as typeof fetch;
  await waitHealthy("http://x", { fetchImpl, intervalMs: 1, tries: 10 });
  expect(calls).toBe(3);
});

test("waitHealthy throws after exhausting tries", async () => {
  const fetchImpl = (async () => ({ ok: false } as Response)) as unknown as typeof fetch;
  await expect(waitHealthy("http://x", { fetchImpl, intervalMs: 1, tries: 3 })).rejects.toThrow();
});
