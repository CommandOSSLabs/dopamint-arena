interface EnvShape {
  [key: string]: string | undefined;
}

const env: EnvShape =
  (globalThis as { process?: { env?: EnvShape } }).process?.env ?? {};

function readString(name: string, fallback?: string): string {
  const value = env[name] ?? fallback;
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

function readOptionalList(name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readNumber(name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`invalid number env ${name}`);
  return value;
}

function readBigInt(name: string, fallback: bigint): bigint {
  const raw = env[name];
  if (!raw) return fallback;
  return BigInt(raw);
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (!raw) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export interface ServerConfig {
  port: number;
  clientOrigin: string;
  suiNetworkName: string;
  suiNetwork: string;
  suiTunnelPackageId: string;
  gameCoinType: string;
  gameCoinSymbol: string;
  botPrivateKeys: string[];
  allowDevBotKeys: boolean;
  defaultStake: bigint;
  defaultTimeoutMs: bigint;
  defaultPenaltyAmount: bigint;
}

export function loadServerConfig(): ServerConfig {
  return {
    port: readNumber("PORT", 3002),
    clientOrigin: readString("CLIENT_ORIGIN", "http://localhost:5173"),
    suiNetworkName: readString("SUI_NETWORK_NAME", "testnet"),
    suiNetwork: readString(
      "SUI_NETWORK",
      "https://fullnode.testnet.sui.io:443",
    ),
    suiTunnelPackageId: readString("SUI_TUNNEL_PACKAGE_ID", "0x0"),
    gameCoinType:
      env.GAME_COIN_TYPE?.trim() ||
      env.COIN_TYPE?.trim() ||
      env.VITE_COIN_TYPE?.trim() ||
      "",
    gameCoinSymbol: readString("GAME_COIN_SYMBOL", env.COIN_SYMBOL ?? "BUCK"),
    botPrivateKeys: readOptionalList("BOT_PRIVATE_KEYS"),
    allowDevBotKeys: readBoolean("ALLOW_DEV_BOT_KEYS", false),
    defaultStake: readBigInt("DEFAULT_STAKE", 5000n),
    defaultTimeoutMs: readBigInt("DEFAULT_TIMEOUT_MS", 3_600_000n),
    defaultPenaltyAmount: readBigInt("DEFAULT_PENALTY_AMOUNT", 0n),
  };
}
