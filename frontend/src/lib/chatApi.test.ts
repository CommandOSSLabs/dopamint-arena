import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ChatApiClient } from "./chatApi.ts";

test("chat returns assistant text", async () => {
  const fetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ response: "hello" }),
  } as Response));
  const client = new ChatApiClient("http://localhost:8080", fetch as any);
  const answer = await client.chat([{ role: "user", content: "hi" }]);
  assert.equal(answer, "hello");
});

test("topic returns topic string", async () => {
  const fetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ topic: "weather" }),
  } as Response));
  const client = new ChatApiClient("http://localhost:8080", fetch as any);
  const topic = await client.topic();
  assert.equal(topic, "weather");
});
