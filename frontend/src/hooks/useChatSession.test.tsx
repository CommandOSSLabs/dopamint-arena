import "global-jsdom/register";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useChatSession } from "./useChatSession.ts";
import type { ChatApiClient, ChatApiMessage } from "../lib/chatApi.ts";
import type { ChatTransport } from "../lib/chatSession.ts";

test("useChatSession fetches topic and sends a message", async () => {
  let onFrameConsumer: ((bytes: Uint8Array) => void) | null = null;
  const sent: Uint8Array[] = [];
  const fakeTransport: ChatTransport = {
    send: (bytes) => sent.push(bytes),
    onFrame: (cb) => {
      onFrameConsumer = cb;
    },
  };

  const fakeApi: ChatApiClient = {
    chat: async () => "",
    topic: async () => "weather",
    subscribeLive: () => () => {},
  } as unknown as ChatApiClient;

  const { result } = renderHook(() =>
    useChatSession({
      api: fakeApi,
      transport: fakeTransport,
      myName: "player",
    }),
  );

  await waitFor(() => assert.equal(result.current.topic, "weather"));

  act(() => {
    result.current.setInput("hi bot");
  });
  await act(async () => {
    await result.current.send();
  });

  assert.equal(result.current.input, "");
  assert.equal(sent.length, 1);
  const parsed = JSON.parse(new TextDecoder().decode(sent[0]));
  assert.equal(parsed.text, "hi bot");

  act(() => {
    onFrameConsumer?.(
      new TextEncoder().encode(
        JSON.stringify({ type: "chat/text", sender: "bot", text: "hello" }),
      ),
    );
  });

  assert.equal(result.current.messages.length, 2);
  assert.equal(result.current.messages[1].text, "hello");
  assert.equal(result.current.messages[1].isMe, false);
});
