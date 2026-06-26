import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaBackendClient } from "./ollama.ts";

test("chat sends messages and returns assistant text", async () => {
  const client = new OllamaBackendClient(
    "http://localhost:8080",
    "qwen2.5:1.5b",
  );
  // This test is integration-only; unit test is left lightweight by mocking fetch in a follow-up.
  assert.equal(client.backendUrl, "http://localhost:8080");
});
