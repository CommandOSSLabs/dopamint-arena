import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createChatProtocol,
  toChatApiMessages,
  type ChatMessage,
} from "./session-core.ts";

test("createChatProtocol returns a chat protocol instance", () => {
  const protocol = createChatProtocol("0xchat");
  assert.ok(protocol);
  assert.equal(protocol.name, "chat.v1");
});

test("toChatApiMessages alternates roles by sender name", () => {
  const messages: ChatMessage[] = [
    { sender: "You", text: "hello" },
    { sender: "Bot", text: "hi there" },
    { sender: "You", text: "how are you?" },
  ];
  const out = toChatApiMessages(messages);
  assert.deepEqual(out, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
    { role: "user", content: "how are you?" },
  ]);
});
