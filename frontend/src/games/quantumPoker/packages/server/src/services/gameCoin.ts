import type { CoinStruct, SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  Transaction,
  type TransactionObjectArgument,
} from "@mysten/sui/transactions";
import { SUI_TYPE_ARG } from "@mysten/sui/utils";

export interface StakeCoinSelection {
  coinA: TransactionObjectArgument;
  coinB: TransactionObjectArgument;
}

export interface SelectStakeCoinsParams {
  client: SuiJsonRpcClient;
  tx: Transaction;
  owner: string;
  coinType: string;
  coinSymbol: string;
  stake: bigint;
}

export function gameCoinConfigured(coinType: string): boolean {
  return coinType.trim() !== "";
}

function isSuiCoin(coinType: string): boolean {
  return coinType === SUI_TYPE_ARG || coinType === "0x2::sui::SUI";
}

async function getAllCoins(
  client: SuiJsonRpcClient,
  owner: string,
  coinType: string,
): Promise<CoinStruct[]> {
  const coins: CoinStruct[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await client.getCoins({
      owner,
      coinType,
      cursor,
      limit: 50,
    });
    coins.push(...page.data);
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  return coins;
}

function selectFundingCoins(
  coins: CoinStruct[],
  needed: bigint,
  coinSymbol: string,
): CoinStruct[] {
  const selected: CoinStruct[] = [];
  let total = 0n;
  for (const coin of [...coins].sort((a, b) =>
    BigInt(a.balance) > BigInt(b.balance) ? -1 : 1,
  )) {
    selected.push(coin);
    total += BigInt(coin.balance);
    if (total >= needed) return selected;
  }
  throw new Error(
    `bot wallet has insufficient ${coinSymbol}: need ${needed.toString()}, available ${total.toString()}`,
  );
}

export async function selectStakeCoins({
  client,
  tx,
  owner,
  coinType,
  coinSymbol,
  stake,
}: SelectStakeCoinsParams): Promise<StakeCoinSelection> {
  if (!gameCoinConfigured(coinType)) {
    throw new Error("GAME_COIN_TYPE or COIN_TYPE must be configured");
  }
  if (stake <= 0n) throw new Error("stake must be positive");

  if (isSuiCoin(coinType)) {
    const [coinA, coinB] = tx.splitCoins(tx.gas, [
      tx.pure.u64(stake),
      tx.pure.u64(stake),
    ]);
    return { coinA, coinB };
  }

  const fundingCoins = selectFundingCoins(
    await getAllCoins(client, owner, coinType),
    stake * 2n,
    coinSymbol,
  );
  const [main, ...rest] = fundingCoins.map((coin) =>
    tx.objectRef({
      objectId: coin.coinObjectId,
      digest: coin.digest,
      version: coin.version,
    }),
  );
  if (!main) {
    throw new Error(`bot wallet has no ${coinSymbol} coins`);
  }
  if (rest.length > 0) {
    tx.mergeCoins(main, rest);
  }
  const [coinA, coinB] = tx.splitCoins(main, [
    tx.pure.u64(stake),
    tx.pure.u64(stake),
  ]);
  return { coinA, coinB };
}
