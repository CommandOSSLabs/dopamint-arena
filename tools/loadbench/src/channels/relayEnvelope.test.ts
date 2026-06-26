import { test, expect } from "bun:test";
import { framePayload, payloadFrame } from "./relayEnvelope";

test("frame bytes round-trip through the relay payload envelope", () => {
  const inner = JSON.stringify({ kind: "ack", nonce: "1", sigResponder: "ab" });
  const bytes = new TextEncoder().encode(inner);
  const payload = framePayload(bytes);
  expect(JSON.parse(payload).t).toBe("frame");
  const back = payloadFrame(payload);
  expect(back && new TextDecoder().decode(back)).toBe(inner);
});

test("non-frame peer payloads decode to null", () => {
  expect(payloadFrame(JSON.stringify({ t: "hello" }))).toBeNull();
});

test("malformed JSON payload returns null without throwing", () => {
  expect(payloadFrame("not json{")).toBeNull();
});

test("non-object JSON payload (e.g. bare number) returns null without throwing", () => {
  expect(payloadFrame("42")).toBeNull();
});
