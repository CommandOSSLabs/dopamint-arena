import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRouter, json } from "./router";

const ORIGIN = "http://localhost:5173";

describe("router", () => {
  const router = createRouter(ORIGIN, [
    { method: "GET", path: "/api/ping", handler: async () => json({ ok: true }) },
  ]);

  it("routes a matching request", async () => {
    const res = await router(new Request("http://x/api/ping"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  });

  it("returns 404 for unknown path", async () => {
    const res = await router(new Request("http://x/api/nope"));
    assert.equal(res.status, 404);
  });

  it("answers CORS preflight with 204", async () => {
    const res = await router(
      new Request("http://x/api/ping", { method: "OPTIONS" })
    );
    assert.equal(res.status, 204);
    assert.ok(res.headers.get("Access-Control-Allow-Methods")?.includes("POST"));
  });
});
