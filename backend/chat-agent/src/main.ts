import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromB64 } from "@mysten/sui/utils";
import { runBotVsBot } from "./botVsBot.ts";
import { loadConfig } from "./config.ts";
import { ensureDopamintBalance } from "./funding.ts";
import { MpClient, resolveMpWsUrl } from "./mpClient.ts";
import { OllamaBackendClient } from "./ollama.ts";

export function buildMpUrl(backendUrl: string): string {
  return `${resolveMpWsUrl(backendUrl)}/v1/mp`;
}

function createSuiClient(rpcUrl: string): SuiClient {
  return new SuiClient({ url: rpcUrl || getFullnodeUrl("testnet") });
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const operatorKeypair = Ed25519Keypair.fromSecretKey(fromB64(cfg.operatorKey));
  const operatorAddress = operatorKeypair.toSuiAddress();
  const sui = createSuiClient(cfg.suiRpcUrl);
  const ollama = new OllamaBackendClient(cfg.backendUrl, cfg.ollamaModel);

  await ensureDopamintBalance(
    sui,
    cfg,
    operatorKeypair,
    BigInt(cfg.stakeRaw) * 2n,
  );

  const topic = await ollama.topic();
  const wallet = operatorAddress;

  let tunnelCounter = 0;
  const tunnelIdProvider = () => {
    tunnelCounter += 1;
    return `${cfg.dopamintPackageId}::chat::Tunnel-${Date.now()}-${tunnelCounter}`;
  };

  const alice = new MpClient(buildMpUrl(cfg.backendUrl), wallet);
  const bob = new MpClient(buildMpUrl(cfg.backendUrl), wallet);

  const result = await runBotVsBot({
    alice,
    bob,
    ollama,
    topic,
    tunnelIdProvider,
    maxMoves: 6,
  });

  console.log("bot-vs-bot complete:", result);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
