import { test } from "node:test";
import assert from "node:assert/strict";
import { settlementsUrl, getTranscript } from "./explorerClient";

test("settlementsUrl builds a keyset query with only the set filters", () => {
  assert.equal(
    settlementsUrl("https://api.example", { limit: 50 }),
    "https://api.example/v1/settlements?limit=50",
  );
  assert.equal(
    settlementsUrl("https://api.example", {
      limit: 25,
      cursor: "1750:Dg",
      address: "0xA",
    }),
    "https://api.example/v1/settlements?limit=25&cursor=1750%3ADg&address=0xA",
  );
});

test("settlementsUrl trims a trailing slash on the base", () => {
  assert.equal(
    settlementsUrl("https://api.example/", { limit: 10 }),
    "https://api.example/v1/settlements?limit=10",
  );
});

// The explorer proxies raw Walrus bytes; settle blobs are binary (first byte 0x01), so the
// transcript fetch must NOT JSON-parse — it returns the bytes verbatim for the verifier.
test("getTranscript returns raw bytes and defaults format to 'body' (legacy Walrus)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([0x01, 0x00, 0x01]).buffer, {
      status: 200,
    })) as typeof fetch;
  try {
    const res = await getTranscript("DiG");
    assert.ok(res!.bytes instanceof Uint8Array);
    assert.equal(res!.bytes[0], 0x01);
    // No x-transcript-format header => a whole settle body (the verifier decodes header + entries).
    assert.equal(res!.format, "body");
  } finally {
    globalThis.fetch = orig;
  }
});

test("getTranscript reports format 'entries' when the api serves chunks", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([0x00, 0x02]).buffer, {
      status: 200,
      headers: { "x-transcript-format": "entries" },
    })) as typeof fetch;
  try {
    const res = await getTranscript("DiG");
    assert.equal(res!.format, "entries");
  } finally {
    globalThis.fetch = orig;
  }
});
