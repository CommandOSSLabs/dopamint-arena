import { test, mock } from "node:test";
import assert from "node:assert/strict";
import "global-jsdom/register";
import { render, screen, waitFor } from "@testing-library/react";
import { BotVsBotSpectator } from "./BotVsBotSpectator.tsx";
import type { ChatApiClient, LiveMessage } from "../../lib/chatApi.ts";

test("BotVsBotSpectator renders live messages", async () => {
  let liveCb: ((msg: LiveMessage) => void) | null = null;
  const fakeApi: ChatApiClient = {
    topic: async () => "weather",
    chat: async () => "",
    subscribeLive: (cb) => {
      liveCb = cb;
      return () => {};
    },
  } as unknown as ChatApiClient;

  render(<BotVsBotSpectator api={fakeApi} />);

  assert.equal(screen.getByText("Bot vs Bot Spectator").textContent, "Bot vs Bot Spectator");
  assert.equal(screen.getByText("Waiting for bots to start chatting...").textContent?.length > 0, true);

  liveCb?.({ sender: "bot-a", text: "hello" });

  await waitFor(() => screen.getByText("hello"));
  assert.equal(screen.getByText("bot-a").textContent, "bot-a");
});
