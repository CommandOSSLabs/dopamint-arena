import "global-jsdom/register";
import { test } from "node:test";
import assert from "node:assert/strict";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatWindow } from "./ChatWindow.tsx";
import type { ChatApiClient } from "../../lib/chatApi.ts";
import type { ChatTransport } from "../../lib/chatSession.ts";

test("ChatWindow renders topic and sends message", async () => {
  let onFrameCb: ((bytes: Uint8Array) => void) | null = null;
  const sent: Uint8Array[] = [];
  const fakeTransport: ChatTransport = {
    send: (bytes) => sent.push(bytes),
    onFrame: (cb) => {
      onFrameCb = cb;
    },
  };
  const fakeApi: ChatApiClient = {
    topic: async () => "weather",
    chat: async () => "",
    subscribeLive: () => () => {},
  } as unknown as ChatApiClient;

  render(
    <ChatWindow api={fakeApi} transport={fakeTransport} myName="player" />,
  );

  await waitFor(() => screen.getByText("Topic: weather"));

  const input = screen.getByPlaceholderText("Type a message...");
  fireEvent.change(input, { target: { value: "hello" } });
  fireEvent.click(screen.getByText("Send"));

  await waitFor(() => assert.equal(sent.length, 1));
  assert.equal(screen.getByText("hello").textContent, "hello");
});
