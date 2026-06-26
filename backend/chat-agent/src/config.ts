import "dotenv/config";

export interface ChatAgentConfig {
  suiRpcUrl: string;
  backendUrl: string;
  tunnelPackageId: string;
  dopamintPackageId: string;
  dopamintFaucetId: string;
  dopamintCoinType: string;
  operatorKey: string;
  ollamaModel: string;
  stakeRaw: bigint;
  botPoolSize: number;
  botVsBotEnabled: boolean;
}

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var: ${name}`);
  return v;
}

export function loadConfig(): ChatAgentConfig {
  const whole = BigInt(process.env.CHAT_STAKE_WHOLE_TOKENS ?? "1");
  return {
    suiRpcUrl: process.env.SUI_RPC_URL ?? "https://fullnode.testnet.sui.io:443",
    backendUrl: getEnv("BACKEND_URL"),
    tunnelPackageId: getEnv("TUNNEL_PACKAGE_ID"),
    dopamintPackageId: getEnv("DOPAMINT_PACKAGE_ID"),
    dopamintFaucetId: getEnv("DOPAMINT_FAUCET_ID"),
    dopamintCoinType: getEnv("DOPAMINT_COIN_TYPE"),
    operatorKey: getEnv("SUI_SETTLER_KEY"),
    ollamaModel: process.env.CHAT_OLLAMA_MODEL ?? "qwen2.5:1.5b",
    stakeRaw: whole * 10n ** 9n, // 9 decimals
    botPoolSize: Number(process.env.CHAT_BOT_POOL_SIZE ?? "3"),
    botVsBotEnabled: (process.env.CHAT_BOT_VS_BOT_ENABLED ?? "true") === "true",
  };
}
