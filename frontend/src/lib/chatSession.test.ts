import { test } from "node:test";
import assert from "node:assert/strict";
import { interceptChatFrames } from "./chatSession.ts";

test("interceptor extracts chat text and forwards frame", () => {
  const sent: Uint8Array[] = [];
  const consumed: Uint8Array[] = [];
  const messages: { sender: string; text: string }[] = [];

  const fakeTransport = {
    send: (bytes: Uint8Array) => sent.push(bytes),
    onFrame: (cb: (bytes: Uint8Array) => void) => {
      // simulate receiving a frame later
      setTimeout(() => {
        cb(new TextEncoder().encode(JSON.stringify({ type: "chat/text", sender: "bot", text: "hello" })));
      }, 0);
    },
  };

  const wrapped = interceptChatFrames(fakeTransport, {
    onMessage: (sender, text) => messages.push({ sender, text }),
  });

  const move = new TextEncoder().encode(JSON.stringify({ type: "chat/text", sender: "me", text: "hi" }));
  wrapped.send(move);

  return new Promise<void>((resolve) => {
    wrapped.onFrame((bytes) => {
      consumed.push(bytes);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].sender, "bot");
      assert.equal(messages[0].text, "hello");
      assert.deepEqual(consumed[0], bytes);
      resolve();
    });
  });
});
