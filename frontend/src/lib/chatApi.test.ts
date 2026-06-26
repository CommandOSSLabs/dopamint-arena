import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ChatApiClient } from "./chatApi.ts";

test("chat returns assistant text", async () => {
  const fetch = mock.fn(
    async () =>
      ({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ content: "hello" }),
      }) as Response,
  );
  const client = new ChatApiClient("http://localhost:8080", fetch as any);
  const answer = await client.chat([{ role: "user", content: "hi" }]);
  assert.equal(answer, "hello");
});

test("topic returns topic string", async () => {
  const fetch = mock.fn(
    async () =>
      ({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ topic: "weather" }),
      }) as Response,
  );
  const client = new ChatApiClient("http://localhost:8080", fetch as any);
  const topic = await client.topic();
  assert.equal(topic, "weather");
});

test("topic throws a clear error when the backend returns HTML", async () => {
  const fetch = mock.fn(
    async () =>
      ({
        ok: true,
        headers: new Headers({ "content-type": "text/html" }),
        json: async () => {
          throw new SyntaxError("Unexpected token '<'");
        },
      }) as Response,
  );
  const client = new ChatApiClient("http://localhost:8080", fetch as any);
  await assert.rejects(
    client.topic(),
    /topic failed: backend returned text\/html/,
  );
});
