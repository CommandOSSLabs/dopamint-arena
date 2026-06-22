import { Loader } from "lucide-react";
import { useMemo, useState } from "react";
import { PaymentsProtocol, type PaymentsState } from "../../utils/payments";
import type { PaymentsTunnelState } from "../PaymentsWindow";
import { SUI_DECIMALS } from "@mysten/sui/utils";
import { Transaction } from "@mysten/sui/transactions";
import { PACKAGE_ID } from "../../utils/config";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import type { Party } from "../../utils/Protocol";

interface PaymentsTransferPaymentState extends PaymentsState {
  sig_a?: Uint8Array;
  sig_b?: Uint8Array;
}

interface PaymentsTransferAction {
  amount: string;
  tunnel: PaymentsTunnelState;
  setTunnel: React.Dispatch<React.SetStateAction<PaymentsTunnelState | null>>;
}

export function PaymentsTransferAction({
  amount,
  tunnel,
  setTunnel,
}: PaymentsTransferAction) {
  const currentAccount = useCurrentAccount();

  const payments = useMemo(() => new PaymentsProtocol(), []);

  const [loading, setLoading] = useState<string>();

  const [payment, setPayment] = useState<PaymentsTransferPaymentState>(
    payments.initialState({
      tunnelId: tunnel.id,
      initialBalances: tunnel.initialBalances,
    }),
  );

  const signAndExecuteTransaction = useSignAndExecuteTransaction();

  console.log(payment);

  const handlePayment = (amount: string | number, from: Party) => {
    // Compute next state
    const nextState = payments.applyMove(
      payment,
      {
        amount: BigInt(Number(amount) * 10 ** SUI_DECIMALS),
        from,
      },
      from,
    );

    // Build message for signing (NEW state!)
    const messageBytes = buildCloseMessage({
      channelId: tunnel.id,
      balanceA: nextState.balanceA,
      balanceB: nextState.balanceB,
      nonce: nextState.count,
    });

    return {
      messageBytes,
      nextState,
    };
  };

  return (
    <>
      <button
        disabled={Number(amount) <= 0 || !!loading}
        className="flex items-center justify-center rounded bg-arena-accent w-full h-9 gap-2 font-medium text-arena-bg disabled:opacity-70"
        onClick={async () => {
          try {
            setLoading("send_payment");

            const { messageBytes, nextState } = handlePayment(amount, "A");

            // both signer must sign, to commit signature
            const sigA = await tunnel.signer_A.sign(messageBytes);
            const sigB = await tunnel.signer_B.sign(messageBytes);

            setPayment({
              ...nextState,
              sig_a: sigA,
              sig_b: sigB,
            });
          } catch (err) {
            console.error(err);
          } finally {
            setLoading(undefined);
          }
        }}
      >
        {loading === "send_payment" ? (
          <Loader className="size-4 animate-spin" />
        ) : null}
        Send Payment
      </button>

      <button
        disabled={Number(amount) <= 0 || !!loading}
        className="flex items-center justify-center rounded bg-yellow-500 w-full h-9 gap-2 font-medium text-arena-bg disabled:opacity-70"
        onClick={async () => {
          try {
            setLoading("send_service");

            const { messageBytes, nextState } = handlePayment(amount, "B");

            // both signer must sign, to commit signature
            const sigA = await tunnel.signer_A.sign(messageBytes);
            const sigB = await tunnel.signer_B.sign(messageBytes);

            setPayment({
              ...nextState,
              sig_b: sigB,
              sig_a: sigA,
            });
          } catch (err) {
            console.error(err);
          } finally {
            setLoading(undefined);
          }
        }}
      >
        {loading === "send_service" ? (
          <Loader className="size-4 animate-spin" />
        ) : null}
        Send Service
      </button>

      <button
        disabled={!!loading?.length}
        className="w-full h-9 bg-arena-muted disabled:opacity-70"
        onClick={async () => {
          try {
            if (
              !payment.sig_a?.length ||
              !payment.sig_b?.length ||
              !currentAccount?.address
            ) {
              throw "not found payment conditions";
            }

            setLoading("settle");

            const tx = new Transaction();

            const [coinA] = tx.moveCall({
              target: `${PACKAGE_ID}::payment_channel::cooperative_close`,
              typeArguments: [tunnel.coinType],
              arguments: [
                tx.object(tunnel.id),

                tx.pure.u64(payment.count),

                tx.pure.u64(payment.balanceA),
                tx.pure.u64(payment.balanceB),

                tx.pure.vector("u8", payment.sig_a),
                tx.pure.vector("u8", payment.sig_b),
              ],
            });

            // Only transfer if there's real value
            if (payment.balanceA > 0) {
              tx.transferObjects([coinA], currentAccount.address);
            } else {
              // Destroy the zero coin on-chain
              tx.moveCall({
                target: "0x2::coin::destroy_zero",
                typeArguments: [tunnel.coinType],
                arguments: [coinA],
              });
            }

            // tx.transferObjects([coinA], currentAccount.address);

            await signAndExecuteTransaction.mutateAsync({
              transaction: tx,
            });

            setTunnel(null);
          } finally {
            setLoading(undefined);
          }
        }}
      >
        {loading === "settle" ? (
          <Loader className="size-4 animate-spin" />
        ) : null}
        Settle
      </button>
    </>
  );
}

const buildCloseMessage = ({
  channelId,
  balanceA,
  balanceB,
  nonce,
}: {
  channelId: string | Uint8Array;
  balanceA: bigint | number;
  balanceB: bigint | number;
  nonce: bigint | number;
}): Uint8Array => {
  const prefix = new TextEncoder().encode("payment_channel::close");

  // Normalize Channel ID to 32 bytes
  let cidBytes: Uint8Array;
  if (typeof channelId === "string") {
    const clean = channelId.replace(/^0x/, "");
    cidBytes = new Uint8Array(
      clean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
    );
  } else {
    cidBytes = channelId;
  }

  // Take last 32 bytes if longer (common with Sui Object IDs)
  if (cidBytes.length > 32) {
    cidBytes = cidBytes.slice(-32);
  }

  const u64ToBe = (n: bigint | number): Uint8Array => {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigUint64(0, BigInt(n), false);
    return new Uint8Array(buf);
  };

  const ba = u64ToBe(balanceA);
  const bb = u64ToBe(balanceB);
  const nn = u64ToBe(nonce);

  const totalLen = prefix.length + 32 + 8 + 8 + 8;
  const message = new Uint8Array(totalLen);

  let offset = 0;
  message.set(prefix, offset);
  offset += prefix.length;
  message.set(cidBytes, offset);
  offset += 32;
  message.set(ba, offset);
  offset += 8;
  message.set(bb, offset);
  offset += 8;
  message.set(nn, offset);

  return message;
};
