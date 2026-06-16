import { describe, expect, it } from "bun:test";
import { createRouter, json } from "./router";

const ORIGIN = "http://localhost:5173";

describe("router", () => {
  const router = createRouter(ORIGIN, [
    { method: "GET", path: "/api/ping", handler: async () => json({ ok: true }) },
  ]);

  it("routes a matching request", async () => {
    const res = await router(new Request("http://x/api/ping"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("returns 404 for unknown path", async () => {
    const res = await router(new Request("http://x/api/nope"));
    expect(res.status).toBe(404);
  });

  it("answers CORS preflight with 204", async () => {
    const res = await router(
      new Request("http://x/api/ping", { method: "OPTIONS" })
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});
