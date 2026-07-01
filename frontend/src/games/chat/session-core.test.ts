import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_MAX_MOVES_PER_TURN,
  chatShouldSettleForMoveCap,
  createChatProtocol,
  toChatApiMessages,
  type ChatMessage,
} from "./session-core.ts";
import { MAX_MOVES_PER_TUNNEL } from "../../../../sui-tunnel-ts/src/proof/limits.ts";

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

test("chatShouldSettleForMoveCap keeps a full exchange under the move ceiling", () => {
  // Plenty of room early on: keep chatting.
  assert.equal(chatShouldSettleForMoveCap(0), false);
  // Last update count that still leaves room for a human+bot pair.
  const lastSafe = MAX_MOVES_PER_TUNNEL - CHAT_MAX_MOVES_PER_TURN - 1;
  assert.equal(chatShouldSettleForMoveCap(lastSafe), false);
  // One past that a fresh exchange could reach the cap → settle at this boundary.
  assert.equal(chatShouldSettleForMoveCap(lastSafe + 1), true);
  assert.equal(chatShouldSettleForMoveCap(MAX_MOVES_PER_TUNNEL), true);
});
