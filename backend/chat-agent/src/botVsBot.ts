import { ChatMatchDriver } from "./matchDriver.ts";
import type { OllamaBackendClient } from "./ollama.ts";
import type { MpClient } from "./mpClient.ts";
import { chatProtocol, type ChatMessage } from "sui-tunnel-ts/protocol/chat";

export interface BotVsBotOptions {
  alice: MpClient;
  bob: MpClient;
  ollama: OllamaBackendClient;
  topic: string;
  tunnelIdProvider: () => string;
  maxMoves: number;
}

export interface BotVsBotResult {
  matchId: string;
  messages: ChatMessage[];
}

export async function runBotVsBot(
  opts: BotVsBotOptions,
): Promise<BotVsBotResult> {
  const { alice, bob, ollama, topic, tunnelIdProvider, maxMoves } = opts;

  await Promise.all([alice.connect(), bob.connect()]);

  const [aliceMatch, bobMatch] = await Promise.all([
    alice.quickMatch("chat"),
    bob.quickMatch("chat"),
  ]);

  if (aliceMatch.matchId !== bobMatch.matchId) {
    throw new Error("match ids do not match");
  }

  const matchId = aliceMatch.matchId;

  const aliceChannel = alice.channel(matchId);
  const bobChannel = bob.channel(matchId);

  const aliceTunnel = tunnelIdProvider();
  const bobTunnel = tunnelIdProvider();

  alice.announceTunnel(matchId, aliceTunnel);
  bob.announceTunnel(matchId, bobTunnel);

  const aliceDriver = new ChatMatchDriver(
    aliceChannel,
    chatProtocol(aliceMatch.role),
    ollama,
    aliceTunnel,
    "bot-alice",
  );
  const bobDriver = new ChatMatchDriver(
    bobChannel,
    chatProtocol(bobMatch.role),
    ollama,
    bobTunnel,
    "bot-bob",
  );

  const racePromise = Promise.all([
    aliceDriver.start(topic),
    bobDriver.start(topic),
  ]);

  setTimeout(() => {
    aliceDriver.requestStop();
    bobDriver.requestStop();
  }, maxMoves * 600 + 2000);

  await racePromise;

  const transcript = aliceDriver.snapshot();
  await ollama.publishTranscript(transcript.messages);
  return { matchId, messages: transcript.messages };
}
