import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ChatMatchDriver } from "./matchDriver.ts";
import { ChatState, chatProtocol } from "sui-tunnel-ts/protocol/chat";
import { innerFrameJsonFromRawBytes } from "sui-tunnel-ts/core/distributedFrame";
import type { MpChannel } from "./mpClient.ts";

const fakeChannel = (): MpChannel => {
  let onFrameCb: ((bytes: Uint8Array) => void) | undefined;
  const peerMessages: unknown[] = [];
  return {
    transport: {
      send: (bytes: Uint8Array) => {
        const inner = innerFrameJsonFromRawBytes(bytes);
        if (inner) onFrameCb?.(inner);
      },
      onFrame: (cb) => {
        onFrameCb = cb;
      },
    },
    sendPeer: (msg) => peerMessages.push(msg),
    onPeer: () => {},
  };
};

test("ChatMatchDriver opens protocol and sends hello", async () => {
  const protocol = chatProtocol();
  const channel = fakeChannel();
  const ollama = {
    chat: mock.fn(async () => "hi"),
    topic: mock.fn(async () => "weather"),
  };
  const driver = new ChatMatchDriver(
    channel,
    protocol,
    ollama as any,
    "0xTUNNEL",
    "bot-A",
  );
  await driver.start("weather");
  assert.equal(protocol.state(), ChatState.Ready);
  await driver.stop();
});
