import { RefObject, useEffect, useRef, useState } from "react";
import { SUI_DECIMALS } from "@mysten/sui/utils";
import * as ed from "@noble/curves/ed25519.js";
import type { PeerMessage } from "@/pvp/mpClient";
import { Party, PaymentsProtocol, PaymentsState } from "sui-tunnel-ts/protocol";
import { PaymentsChallengeResultProps } from ".";
import { PaymentsTunnelState } from "../PaymentsWindow";
import { useCurrentAccount } from "@mysten/dapp-kit";

const ROUND_REWARD_MIST = BigInt(Math.round(0.01 * 10 ** SUI_DECIMALS));

interface PaymentsChallengeAnswersProps {
  isHost: boolean;
  tunnel: PaymentsTunnelState;
  currentPuzzle: PaymentsChallengeResultProps["currentPuzzle"];
  payments: PaymentsProtocol;
  paymentStateRef: RefObject<
    PaymentsState & {
      sig_a?: Uint8Array;
      sig_b?: Uint8Array;
    }
  >;
  onNextRound: () => void;
}

export default function PaymentsChallengeAnswers({
  isHost,
  tunnel,
  currentPuzzle,
  payments,
  paymentStateRef,
  onNextRound,
}: PaymentsChallengeAnswersProps) {
  const currentAccount = useCurrentAccount();

  const [countRound, setCountRound] = useState(5);

  const [selectAnswer, setSelectAnswer] = useState<{
    value: string;
    correct: boolean;
    timestamp: number;
    sender: string;
  }>();

  const getParty = isHost ? "A" : "B";

  const isAnswerCorrectForSelf =
    selectAnswer?.sender === currentAccount?.address && selectAnswer?.correct;

  // get transport to update state
  useEffect(() => {
    tunnel.channel.transport.onFrame((event) => {
      const msg = JSON.parse(new TextDecoder().decode(event)) as NonNullable<
        typeof selectAnswer
      >;

      // update state for who never click
      handlePayerPayment(getParty);
      setSelectAnswer(msg);
    });
  }, [tunnel, getParty]);

  // Handle next round when selected answer
  useEffect(() => {
    if (!selectAnswer) return;

    const cbCounter = setInterval(() => {
      setCountRound((prev) => {
        if (prev <= 1) {
          clearInterval(cbCounter);

          onNextRound();

          return 0;
        }

        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(cbCounter);
  }, [selectAnswer]);

  const handlePayerPayment = async (payerParty: Party) => {
    const nextState = payments.applyMove(
      paymentStateRef.current,
      {
        amount: ROUND_REWARD_MIST,
        from: payerParty,
      },
      payerParty,
    );

    const messageBytes = buildCloseMessage({
      channelId: tunnel.tunnelId,
      balanceA: nextState.balanceA,
      balanceB: nextState.balanceB,
      nonce: nextState.count,
    });

    const mySig = ed.ed25519.sign(messageBytes, tunnel.ephemeral.secretKey);

    // tunnel.channel.sendPeer({
    //   t: "payment_update",
    //   nextState: {
    //     balanceA: String(nextState.balanceA),
    //     balanceB: String(nextState.balanceB),
    //     total: String(nextState.total),
    //     count: String(nextState.count),
    //   },
    //   mySig: Array.from(mySig),
    // } as unknown as Exclude<PeerMessage, { t: "frame" }>);

    // paymentStateRef.current = { ...nextState };

    // // Check after local payment
    // if (nextState.balanceA === 0n || nextState.balanceB === 0n) {
    //   triggerGameEnd();
    // }

    console.log(
      `[Payment] Success → A: ${nextState.balanceA} | B: ${nextState.balanceB}`,
    );
  };

  if (!currentPuzzle) return;

  return (
    <div className="rounded-md p-2 transition-colors duration-500">
      {selectAnswer ? (
        <div className="mb-3 text-center text-sm text-muted-foreground">
          {isAnswerCorrectForSelf
            ? "🏆 You won this round! +0.01 SUI"
            : "💸 You lost this round. -0.01 SUI"}

          <span className="ml-2 font-medium text-foreground">
            Next round in {countRound}s…
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        {currentPuzzle.answers.map((option, index) => {
          const isSelected = selectAnswer?.value === option.value;

          return (
            <button
              key={index}
              disabled={!!selectAnswer}
              className={`border rounded-sm p-4 space-y-2 transition-all active:scale-[0.98] disabled:cursor-not-allowed

               ${
                 isSelected
                   ? selectAnswer.correct
                     ? "bg-green-500/20 border-green-500 text-green-400"
                     : "bg-red-500/20 border-red-500 text-red-400"
                   : "border-border hover:border-(--wal-violet)"
               }
            `}
              onClick={() => {
                const payload = {
                  value: option.value,
                  correct: option.correct,
                  timestamp: Date.now(),
                  sender: currentAccount?.address as string,
                };

                handlePayerPayment(getParty);

                tunnel.channel.transport.send(
                  new TextEncoder().encode(JSON.stringify(payload)),
                );

                setSelectAnswer(payload);
              }}
            >
              <div className="text-xs font-bold text-(--wal-violet)">
                {option.label}
              </div>

              <div className="text-center text-sm font-medium">
                {option.value}
              </div>

              {isSelected && (
                <div className="flex gap-1 justify-center text-xs text-muted-foreground">
                  {selectAnswer.sender === currentAccount?.address
                    ? "You"
                    : "Opponent"}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const buildCloseMessage = ({
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

  let cidBytes: Uint8Array;
  if (typeof channelId === "string") {
    const clean = channelId.replace(/^0x/, "");
    cidBytes = new Uint8Array(
      clean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
    );
  } else {
    cidBytes = channelId;
  }

  if (cidBytes.length > 32) cidBytes = cidBytes.slice(-32);

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
