import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildBotMove,
  buildUserMove,
  DEBATE_TOPICS,
  debateMessages,
  debateSystemPrompt,
  deriveView,
  randomDebateTopic,
} from "./session-core";
import type { ChatState } from "sui-tunnel-ts/protocol/chat";

describe("session-core", () => {
  it("buildUserMove trims text and rejects empty input", () => {
    const move = buildUserMove("  hello world  ");
    assert.equal(move.kind, "msg");
    assert.equal(move.text, "hello world");
    assert.throws(() => buildUserMove("   "), /non-empty/);
  });

  it("buildBotMove trims text and rejects empty input", () => {
    const move = buildBotMove("reply");
    assert.equal(move.kind, "msg");
    assert.equal(move.text, "reply");
    assert.throws(() => buildBotMove(""), /non-empty/);
  });

  it("randomDebateTopic returns an entry from the topic list", () => {
    const topic = randomDebateTopic();
    assert.ok(DEBATE_TOPICS.includes(topic));
  });

  it("randomDebateTopic is deterministic when given a seeded rng", () => {
    let value = 0.25;
    const rng = () => value;
    const topic = randomDebateTopic(rng);
    assert.equal(topic, DEBATE_TOPICS[Math.floor(0.25 * DEBATE_TOPICS.length)]);
  });

  it("debateSystemPrompt returns distinct prompts for A and B", () => {
    const a = debateSystemPrompt("A");
    const b = debateSystemPrompt("B");
    assert.notEqual(a, b);
    assert.ok(a.includes("FOR"));
    assert.ok(b.includes("AGAINST"));
  });

  it("debateMessages formats the topic as the first user message and maps history by party", () => {
    const topic = "Is water wet?";
    // Transcript order: topic (Party A / user), Party B reply, Party A reply.
    const history = [
      { role: "user" as const, text: topic },
      { role: "assistant" as const, text: "No, it is not." },
      { role: "user" as const, text: "Yes, it is." },
    ];
    // From Party B's perspective: its own reply is assistant, opponent's replies are user.
    // The opponent's last reply is kept last so the model responds to it.
    const messages = debateMessages(topic, history, "B");
    assert.deepEqual(messages, [
      { role: "user", content: topic },
      { role: "assistant", content: "No, it is not." },
      { role: "user", content: "Yes, it is." },
      { role: "user", content: "Party B, give your rebuttal now." },
    ]);
  });

  it("deriveView exposes the on-chain counters", () => {
    const state: ChatState = {
      transcriptDigest: new Uint8Array(32),
      messageCount: 5n,
      lastSender: "B",
      balanceA: 80n,
      balanceB: 120n,
      total: 200n,
    };
    const view = deriveView(state);
    assert.equal(view.messageCount, 5);
    assert.equal(view.lastSender, "B");
    assert.equal(view.balanceA, 80);
    assert.equal(view.balanceB, 120);
  });
});
