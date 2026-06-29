import { test } from "node:test";
import assert from "node:assert/strict";

import { faucetMtps, faucetMtpsInternal } from "./mtps.ts";

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

// The internal (ops) faucet POSTs to /v1/faucet/internal with the admin token as a Bearer header,
// and returns the backend's full mint result (digest + amount + recipient). The token must NOT leak
// into the JSON body — it travels only in the Authorization header.
test("faucetMtpsInternal sends a Bearer token and returns the mint result", async () => {
  const calls: { url: string; headers: unknown; body: unknown }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const i = init as { headers?: Record<string, string>; body?: string };
    calls.push({
      url: String(url),
      headers: i?.headers,
      body: JSON.parse(i?.body ?? "{}"),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        digest: "DiGeSt",
        amount: 1_000_000,
        recipient: "0xabc",
      }),
      text: async () => "",
    };
  }) as unknown as typeof fetch;
  try {
    const res = await faucetMtpsInternal({
      adminToken: "s3cret",
      recipient: "0xabc",
    });
    assert.deepEqual(res, {
      digest: "DiGeSt",
      amount: 1_000_000,
      recipient: "0xabc",
    });
    assert.match(calls[0].url, /\/v1\/faucet\/internal$/);
    assert.equal(
      (calls[0].headers as Record<string, string>).authorization,
      "Bearer s3cret",
    );
    // Only the recipient — no amount/toBalance when unset, and crucially no token in the body.
    assert.deepEqual(calls[0].body, { recipient: "0xabc" });
  } finally {
    globalThis.fetch = orig;
  }
});

// amount + toBalance reach the backend so an ops mint can pick a custom amount and the owned-coin path.
test("faucetMtpsInternal forwards amount and toBalance", async () => {
  const bodies: unknown[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    bodies.push(JSON.parse((init as { body?: string })?.body ?? "{}"));
    return {
      ok: true,
      status: 200,
      json: async () => ({ digest: "d", amount: 42, recipient: "0xabc" }),
      text: async () => "",
    };
  }) as unknown as typeof fetch;
  try {
    await faucetMtpsInternal({
      adminToken: "t",
      recipient: "0xabc",
      amount: 42,
      toBalance: false,
    });
    assert.deepEqual(bodies[0], {
      recipient: "0xabc",
      amount: 42,
      toBalance: false,
    });
  } finally {
    globalThis.fetch = orig;
  }
});

// A bad token is a 401; the page surfaces the backend's clean message + status (same path as public).
test("faucetMtpsInternal throws a clean message + status on a non-2xx", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 401,
    json: async () => ({}),
    text: async () =>
      JSON.stringify({
        error: {
          code: "unauthorized",
          message: "missing or invalid bearer token",
        },
      }),
  })) as unknown as typeof fetch;
  try {
    await faucetMtpsInternal({ adminToken: "wrong", recipient: "0xabc" });
    assert.fail("expected faucetMtpsInternal to throw");
  } catch (e) {
    const err = e as Error & { status?: number };
    assert.equal(err.status, 401);
    assert.equal(err.message, "missing or invalid bearer token");
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
