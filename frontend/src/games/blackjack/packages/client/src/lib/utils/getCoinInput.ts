import { CoinStruct } from "@mysten/sui/client";
import { Transaction, TransactionObjectInput } from "@mysten/sui/transactions";

export function getCoinInput({
  tx,
  coinType,
  userCoins,
  amount,
}: {
  tx: Transaction;
  coinType: string;
  userCoins: CoinStruct[];
  amount: number;
}): TransactionObjectInput {
  let coinInput: TransactionObjectInput | undefined;
  if (coinType === "0x2::sui::SUI") {
    coinInput = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
  } else {
    const targetCoins = userCoins.filter((coin) => coin.coinType == coinType);
    let total_balance = 0;
    const [mainCoin, ...otherCoins] = targetCoins.map((coin) => {
      total_balance += parseInt(coin.balance);
      return tx.objectRef({
        objectId: coin.coinObjectId,
        digest: coin.digest,
        version: coin.version,
      });
    });
    if (total_balance < amount) {
      const context = {
        total_balance: Math.ceil(total_balance / 10 ** 9),
        amount_to_input: Math.ceil(amount / 10 ** 9),
        lack: Math.ceil((amount - total_balance) / 10 ** 9),
      };
      throw new Error(
        `Insufficient balance. This action need ${context.amount_to_input} Bucket USD.\n You need ${context.lack} more Bucket USD to continue.`
      );
    }
    if (mainCoin && otherCoins.length > 0) {
      tx.mergeCoins(mainCoin, otherCoins);
    }
    coinInput = tx.splitCoins(mainCoin, [tx.pure.u64(amount)]);
  }
  return coinInput;
}
