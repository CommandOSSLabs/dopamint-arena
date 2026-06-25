import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { runBotVsBot } from "./botVsBot.ts";
import { chatProtocol } from "sui-tunnel-ts/protocol/chat";
import type { MatchInfo, MpChannel, MpClient } from "./mpClient.ts";
import type { OllamaBackendClient } from "./ollama.ts";

const fakeClient = (
  name: string,
  role: "A" | "B",
  opponent: string,
): MpClient => {
  return {
    connect: () => Promise.resolve(),
    quickMatch: () =>
      Promise.resolve({
        matchId: "m1",
        role,
        opponentWallet: opponent,
        game: "chat",
      } as MatchInfo),
    channel: () => fakeChannel(name, role),
    announceTunnel: () => {},
    publicKeyHex: () => name,
  } as unknown as MpClient;
};

const fakeChannel = (name: string, role: "A" | "B"): MpChannel => {
  const transport = {
    send: (bytes: Uint8Array) => {},
    onFrame: () => {},
  };
  return {
    transport,
    sendPeer: () => {},
    onPeer: (cb) => {
      // nothing
    },
  } as MpChannel;
};

test("runBotVsBot returns transcript", async () => {
  const alice = fakeClient("alice", "A", "bob");
  const bob = fakeClient("bob", "B", "alice");
  const publishTranscriptMock = mock.fn(async () => {});
  const ollama = {
    chat: mock.fn(async () => "hi there"),
    topic: mock.fn(async () => "weather"),
    publishTranscript: publishTranscriptMock,
  } as unknown as OllamaBackendClient;

  const tunnelIdProvider = () => "0xTUNNEL";
  const result = await runBotVsBot({
    alice,
    bob,
    ollama,
    topic: "weather",
    tunnelIdProvider,
    maxMoves: 2,
  });
  assert.equal(result.messages.length > 0, true);
  assert.equal(publishTranscriptMock.mock.callCount(), 1);
});
