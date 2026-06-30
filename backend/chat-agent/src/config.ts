import "dotenv/config";

export interface OllamaSpeedOptions {
  /** Cap on generated tokens per chat reply (lower = faster). */
  numPredict: number;
  /** Token cap for topic generation (kept small). */
  topicPredict: number;
  /** Context window in tokens; smaller windows process prompts faster. */
  numCtx: number;
  /** How long Ollama keeps the model resident between calls. */
  keepAlive: string;
}

export interface ChatAgentConfig {
  suiRpcUrl: string;
  backendUrl: string;
  tunnelPackageId: string;
  dopamintPackageId: string;
  dopamintFaucetId: string;
  dopamintCoinType: string;
  operatorKey: string;
  ollamaModel: string;
  /** When empty, the agent routes chat/topic through the authenticated backend proxy. */
  ollamaUrl: string;
  ollamaSpeed: OllamaSpeedOptions;
  stakeRaw: bigint;
  botPoolSize: number;
  botVsBotEnabled: boolean;
}

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var: ${name}`);
  return v;
}

/** Treat an empty or whitespace-only env var as unset. */
function envString(name: string, defaultValue: string): string {
  const v = process.env[name];
  return v?.trim() ? v : defaultValue;
}

function envPositiveNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid env var ${name}: must be a positive number, got ${raw}`);
  }
  return n;
}

export function loadConfig(): ChatAgentConfig {
  const whole = BigInt(process.env.CHAT_STAKE_WHOLE_TOKENS ?? "1");
  return {
    suiRpcUrl: envString(
      "SUI_RPC_URL",
      "https://fullnode.testnet.sui.io:443",
    ),
    backendUrl: getEnv("BACKEND_URL"),
    tunnelPackageId: getEnv("TUNNEL_PACKAGE_ID"),
    dopamintPackageId: getEnv("DOPAMINT_PACKAGE_ID"),
    dopamintFaucetId: getEnv("DOPAMINT_FAUCET_ID"),
    dopamintCoinType: getEnv("DOPAMINT_COIN_TYPE"),
    operatorKey: getEnv("SUI_SETTLER_KEY"),
    ollamaModel: envString("CHAT_OLLAMA_MODEL", "qwen2.5:1.5b"),
    // Empty/unset means use the authenticated backend proxy for chat/topic.
    ollamaUrl: envString("OLLAMA_URL", ""),
    ollamaSpeed: {
      numPredict: envPositiveNumber("CHAT_OLLAMA_NUM_PREDICT", 64),
      topicPredict: envPositiveNumber("CHAT_OLLAMA_TOPIC_PREDICT", 24),
      numCtx: envPositiveNumber("CHAT_OLLAMA_NUM_CTX", 2048),
      keepAlive: envString("CHAT_OLLAMA_KEEP_ALIVE", "30m"),
    },
    stakeRaw: whole * 10n ** 9n, // 9 decimals
    botPoolSize: Number(process.env.CHAT_BOT_POOL_SIZE ?? "3"),
    botVsBotEnabled: (process.env.CHAT_BOT_VS_BOT_ENABLED ?? "true") === "true",
  };
}
