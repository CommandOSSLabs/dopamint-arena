import { RefObject, useEffect, useRef, useState } from "react";
import { SUI_DECIMALS } from "@mysten/sui/utils";
import * as ed from "@noble/curves/ed25519.js";
import type { PeerMessage } from "@/pvp/mpClient";
import { Party, PaymentsProtocol, PaymentsState } from "sui-tunnel-ts/protocol";
import { PaymentsChallengeResultProps } from ".";
import { PaymentsTunnelState } from "../PaymentsWindow";

const ROUND_REWARD_MIST = BigInt(Math.round(0.01 * 10 ** SUI_DECIMALS));

interface PaymentsChallengeAnswersProps {
  currentPuzzle: PaymentsChallengeResultProps["currentPuzzle"];
  tunnel: PaymentsTunnelState;
  currentAddress: string;
  paymentStateRef: RefObject<
    PaymentsState & { sig_a?: Uint8Array; sig_b?: Uint8Array }
  >;
  onRoundEnd: () => void;
  payments: PaymentsProtocol;
  triggerGameEnd: () => void;
}

type RoundResult = "win" | "lose" | null;

type AnswerState = {
  value: string;
  correct: boolean;
  timestamp: number;
} | null;

export default function PaymentsChallengeAnswers({
  currentPuzzle,
  tunnel,
  currentAddress,
  paymentStateRef,
  onRoundEnd,
  payments,
  triggerGameEnd,
}: PaymentsChallengeAnswersProps) {
  const [myAnswer, setMyAnswer] = useState<AnswerState>(null);
  const [opponentAnswer, setOpponentAnswer] = useState<AnswerState>(null);
  const [result, setResult] = useState<RoundResult>(null);
  const [countdown, setCountdown] = useState<number>(5);

  const myAnswerRef = useRef<AnswerState>(null);
  const resultRef = useRef<RoundResult>(null);
  const roundEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  const isHost = currentAddress === tunnel.initialAddress.a;
  const selfParty: Party = isHost ? "A" : "B";

  useEffect(() => {
    setMyAnswer(null);
    setOpponentAnswer(null);
    setResult(null);
    setCountdown(5);
    myAnswerRef.current = null;
    resultRef.current = null;

    if (roundEndTimerRef.current) clearTimeout(roundEndTimerRef.current);
    if (countdownIntervalRef.current)
      clearInterval(countdownIntervalRef.current);
  }, [currentPuzzle]);

  const resolveResult = (outcome: RoundResult) => {
    if (resultRef.current !== null) return;
    resultRef.current = outcome;
    setResult(outcome);
  };

  useEffect(() => {
    if (result === null) return;

    setCountdown(5);
    countdownIntervalRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(countdownIntervalRef.current!);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    roundEndTimerRef.current = setTimeout(() => onRoundEnd(), 5000);

    return () => {
      if (roundEndTimerRef.current) clearTimeout(roundEndTimerRef.current);
      if (countdownIntervalRef.current)
        clearInterval(countdownIntervalRef.current);
    };
  }, [result, onRoundEnd]);

  const handlePayerPayment = async (payerParty: Party) => {
    const amount = ROUND_REWARD_MIST;
    const currentState = paymentStateRef.current!;

    const payerBalance =
      payerParty === "A" ? currentState.balanceA : currentState.balanceB;

    console.log(
      `[Payment] ${payerParty} trying to pay ${amount} | Balance: ${payerBalance}`,
    );

    if (payerBalance < amount) {
      console.warn(
        `[Payment] ${payerParty} insufficient balance. Ending game.`,
      );
      tunnel.channel.sendPeer({ t: "game_end" } as any);
      triggerGameEnd();
      return;
    }

    const nextState = payments.applyMove(
      currentState,
      { amount, from: payerParty },
      payerParty,
    );

    const messageBytes = buildCloseMessage({
      channelId: tunnel.tunnelId,
      balanceA: nextState.balanceA,
      balanceB: nextState.balanceB,
      nonce: nextState.count,
    });

    const mySig = ed.ed25519.sign(messageBytes, tunnel.ephemeral.secretKey);

    tunnel.channel.sendPeer({
      t: "payment_update",
      nextState: {
        balanceA: String(nextState.balanceA),
        balanceB: String(nextState.balanceB),
        total: String(nextState.total),
        count: String(nextState.count),
      },
      mySig: Array.from(mySig),
    } as unknown as Exclude<PeerMessage, { t: "frame" }>);

    paymentStateRef.current = { ...nextState };

    // Check after local payment
    if (nextState.balanceA === 0n || nextState.balanceB === 0n) {
      triggerGameEnd();
    }

    console.log(
      `[Payment] Success → A: ${nextState.balanceA} | B: ${nextState.balanceB}`,
    );
  };

  const handleMyClick = (optionValue: string) => {
    if (myAnswerRef.current !== null || opponentAnswer !== null) return;

    const option = currentPuzzle?.answers.find((a) => a.value === optionValue);
    if (!option) return;

    const payload = { value: optionValue, timestamp: Date.now() };
    const state: AnswerState = {
      value: optionValue,
      correct: option.correct,
      timestamp: payload.timestamp,
    };

    myAnswerRef.current = state;
    setMyAnswer(state);

    if (option.correct) {
      resolveResult("win");
      const opponentParty: Party = selfParty === "A" ? "B" : "A";
      handlePayerPayment(opponentParty);
    } else {
      resolveResult("lose");
      handlePayerPayment(selfParty);
    }

    tunnel.channel.transport.send(
      new TextEncoder().encode(JSON.stringify(payload)),
    );
  };

  useEffect(() => {
    if (!tunnel.channel) return;

    tunnel.channel.transport.onFrame((event) => {
      if (resultRef.current !== null) return;

      const msg = JSON.parse(new TextDecoder().decode(event)) as {
        value: string;
        timestamp: number;
      };

      const matched = currentPuzzle?.answers.find((a) => a.value === msg.value);
      if (!matched) return;

      setOpponentAnswer({
        value: msg.value,
        correct: matched.correct,
        timestamp: msg.timestamp,
      });

      if (matched.correct) {
        resolveResult("lose");
        handlePayerPayment(selfParty);
      } else {
        resolveResult("win");
      }
    });
  }, [tunnel.channel, currentPuzzle, selfParty]);

  useEffect(() => {
    return () => {
      if (roundEndTimerRef.current) clearTimeout(roundEndTimerRef.current);
      if (countdownIntervalRef.current)
        clearInterval(countdownIntervalRef.current);
    };
  }, []);

  if (!currentPuzzle) return null;

  const getButtonClass = (optionValue: string) => {
    const isMine = myAnswer?.value === optionValue;
    const isOpponents = opponentAnswer?.value === optionValue;

    if (isMine) {
      return myAnswer!.correct
        ? "bg-green-500/20 border-green-500 text-green-400"
        : "bg-red-500/20 border-red-500 text-red-400";
    }
    if (isOpponents) {
      return opponentAnswer!.correct
        ? "bg-green-500/20 border-green-500 text-green-400"
        : "bg-red-500/20 border-red-500 text-red-400";
    }
    return "border-border hover:border-(--wal-violet)";
  };

  const isLocked =
    myAnswerRef.current !== null || opponentAnswer !== null || result !== null;

  const resultOverlayClass =
    result === "win"
      ? "bg-green-500/10"
      : result === "lose"
        ? "bg-red-500/10"
        : "";

  return (
    <div
      className={`rounded-md p-2 transition-colors duration-500 ${resultOverlayClass}`}
    >
      {result !== null && (
        <div className="mb-3 text-center text-sm text-muted-foreground">
          {result === "win"
            ? "🏆 You won this round! +0.01 SUI"
            : "💸 You lost this round. -0.01 SUI"}
          <span className="ml-2 font-medium text-foreground">
            Next round in {countdown}s…
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {currentPuzzle.answers.map((option, index) => (
          <button
            key={index}
            disabled={isLocked}
            className={`border rounded-sm p-4 space-y-2 transition-all active:scale-[0.98] disabled:cursor-not-allowed ${getButtonClass(option.value)}`}
            onClick={() => handleMyClick(option.value)}
          >
            <div className="text-xs font-bold text-(--wal-violet)">
              {option.label}
            </div>
            <div className="text-center text-sm font-medium">
              {option.value}
            </div>
            <div className="flex gap-1 justify-center text-xs text-muted-foreground">
              {myAnswer?.value === option.value && <span>You</span>}
              {opponentAnswer?.value === option.value && <span>Opponent</span>}
            </div>
          </button>
        ))}
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
