import { test, expect } from "bun:test";
import { waitHealthy, httpBaseFromWs, ensureRelay } from "./relayProcess";

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

test("httpBaseFromWs derives http(s) origin from a ws(s) url", () => {
  expect(httpBaseFromWs("ws://127.0.0.1:8080/v1/mp")).toBe("http://127.0.0.1:8080");
  expect(httpBaseFromWs("wss://relay.example.com/v1/mp")).toBe("https://relay.example.com");
});

test("ensureRelay with wsUrl connects to that relay and never spawns", async () => {
  let probed = "";
  const fetchImpl = (async (url: string) => {
    probed = String(url);
    return { ok: true } as Response;
  }) as unknown as typeof fetch;
  const handle = await ensureRelay({ wsUrl: "ws://remote:9090/v1/mp", fetchImpl });
  expect(probed).toBe("http://remote:9090/healthz");
  expect(handle.alreadyRunning).toBe(true);
  handle.stop(); // no-op, must not throw
});
