import { test } from "node:test";
import assert from "node:assert/strict";

import { faucetMtps } from "./mtps.ts";

// The faucet is server-side now (ADR-0015): faucetMtps POSTs the recipient to /v1/faucet and
// returns the backend's mint digest — no PTB, no signer. (resolveBackendUrl is "" under node:test,
// so the request path is the relative /v1/faucet.)
test("faucetMtps POSTs the recipient to /v1/faucet and returns the digest", async () => {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const i = init as { method?: string; body?: string };
    calls.push({
      url: String(url),
      method: i?.method,
      body: JSON.parse(i?.body ?? "{}"),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        digest: "DiGeSt",
        amount: 10000,
        recipient: "0xabc",
      }),
      text: async () => "",
    };
  }) as unknown as typeof fetch;
  try {
    const res = await faucetMtps({ recipient: "0xabc" });
    assert.equal(res.digest, "DiGeSt");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /\/v1\/faucet$/);
    assert.deepEqual(calls[0].body, { address: "0xabc" });
  } finally {
    globalThis.fetch = orig;
  }
});

// The coin-object stake fallback opts out of the address-balance default with toBalance:false, which
// must reach the backend so it picks admin_mint (owned coin) over admin_mint_to_balance.
test("faucetMtps forwards toBalance to the backend", async () => {
  const bodies: unknown[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    bodies.push(JSON.parse((init as { body?: string })?.body ?? "{}"));
    return {
      ok: true,
      status: 200,
      json: async () => ({ digest: "d" }),
      text: async () => "",
    };
  }) as unknown as typeof fetch;
  try {
    await faucetMtps({ recipient: "0xabc", toBalance: false });
    assert.deepEqual(bodies[0], { address: "0xabc", toBalance: false });
  } finally {
    globalThis.fetch = orig;
  }
});

// A non-2xx throws with the backend's CLEAN error.message (not the raw JSON) and the HTTP status
// attached, so a caller (WalletButton, ensureMtps*) can special-case 429 and show a tidy toast.
test("faucetMtps throws a clean message + status on a non-2xx", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 429,
    json: async () => ({}),
    text: async () =>
      JSON.stringify({
        error: { code: "rate_limited", message: "faucet rate limit reached" },
      }),
  })) as unknown as typeof fetch;
  try {
    await faucetMtps({ recipient: "0xabc" });
    assert.fail("expected faucetMtps to throw");
  } catch (e) {
    const err = e as Error & { status?: number };
    assert.equal(err.status, 429);
    assert.equal(err.message, "faucet rate limit reached");
    assert.doesNotMatch(err.message, /[{}]/); // no raw JSON leaked into the message
  } finally {
    globalThis.fetch = orig;
  }
});
