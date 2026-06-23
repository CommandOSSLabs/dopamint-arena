import * as ed from "@noble/curves/ed25519.js";
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import { Loader2Icon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { MpClient, PeerMessage } from "@/pvp/mpClient";
import { PaymentsTunnelState } from "../PaymentsWindow";
import { useQuery } from "@tanstack/react-query";
import PaymentsChallengeTime from "./PaymentsChallengeTime";
import PaymentsChallengePotential from "./PaymentsChallengePotential";
import PaymentsChallengeQuestion from "./PaymentsChallengeQuestion";
import PaymentsChallengePlayer from "./PaymentsChallengePlayer";
import PaymentsChallengeAnswers, {
  buildCloseMessage,
} from "./PaymentsChallengeAnswers";
import { Party, PaymentsProtocol, PaymentsState } from "sui-tunnel-ts/protocol";

export interface PaymentsChallengeResultProps {
  round: number;
  usedPuzzles: Set<string>;
  currentPuzzle?: {
    tx: PaymentsChallengePuzzleProps;
    puzzleIndex: number;
    questionType: "totalGas" | "timestamp";
    key: string;
    answers: {
      label: "A" | "B" | "C" | "D";
      value: string;
      correct: boolean;
    }[];
  };
}

export interface PaymentsChallengePuzzleProps {
  totalGas: number;
  sender: string;
  digest: string;
  timestamp: number;
}

export type PaymentPeerMessage =
  | {
      t: "sync_puzzles";
      randomQuestion: any;
      randomAnswers: any;
      puzzles: PaymentsChallengePuzzleProps[];
    }
  | {
      t: "payment_update";
      nextState: PaymentsState;
      mySig: number[];
    }
  | { t: "game_end" };

interface PaymentsChallengeProps {
  tunnel: PaymentsTunnelState;
  mpClientRef: RefObject<MpClient>;
  setTunnel: Dispatch<SetStateAction<PaymentsTunnelState | null>>;
}

const payments = new PaymentsProtocol();

export default function PaymentsChallenge({
  tunnel,
  setTunnel,
}: PaymentsChallengeProps) {
  const currentAccount = useCurrentAccount();
  const suiClient = useSuiClient();

  const isHost = currentAccount?.address === tunnel.initialAddress.a;

  const [sharedPuzzles, setSharedPuzzles] = useState<
    PaymentsChallengePuzzleProps[]
  >([]);
  const [result, setResult] = useState<PaymentsChallengeResultProps>({
    round: 0,
    currentPuzzle: undefined,
    usedPuzzles: new Set(),
  });
  const [gameEndCountdown, setGameEndCountdown] = useState<number | null>(null);

  const paymentStateRef = useRef<
    PaymentsState & {
      sig_a?: Uint8Array;
      sig_b?: Uint8Array;
    }
  >(
    payments.initialState({
      tunnelId: tunnel.tunnelId,
      initialBalances: tunnel.initialBalances,
    }),
  );

  const triggerGameEnd = () => {
    if (gameEndCountdown === null) {
      setGameEndCountdown(5);
    }
  };

  const checkAndEndIfZeroBalance = (state: PaymentsState) => {
    if (state.balanceA === 0n || state.balanceB === 0n) {
      triggerGameEnd();
      tunnel.channel.sendPeer({
        t: "game_end",
      } as unknown as Exclude<PeerMessage, { t: "frame" }>);
    }
  };

  const handlePaymentUpdate = async (
    nextState: PaymentsState,
    opponentSigArr: number[],
  ) => {
    const messageBytes = buildCloseMessage({
      channelId: tunnel.tunnelId,
      balanceA: BigInt(nextState.balanceA),
      balanceB: BigInt(nextState.balanceB),
      nonce: BigInt(nextState.count),
    });

    const mySig = ed.ed25519.sign(messageBytes, tunnel.ephemeral.secretKey);
    const opponentSig = Uint8Array.from(opponentSigArr);

    paymentStateRef.current = {
      balanceA: BigInt(nextState.balanceA),
      balanceB: BigInt(nextState.balanceB),
      total: BigInt(nextState.total),
      count: BigInt(nextState.count),
      sig_a: isHost ? mySig : opponentSig,
      sig_b: isHost ? opponentSig : mySig,
    };

    checkAndEndIfZeroBalance(nextState);
  };

  const generateAnswers = (
    puzzles: PaymentsChallengePuzzleProps[],
    randomQuestion: Omit<
      NonNullable<PaymentsChallengeResultProps["currentPuzzle"]>,
      "answers"
    >,
  ) => {
    const labels = ["A", "B", "C", "D"] as const;
    let correctValue: string;
    let wrongValues: string[] = [];

    switch (randomQuestion.questionType) {
      case "totalGas": {
        const gas = randomQuestion.tx.totalGas;
        correctValue = String(gas);
        const baseModifier = Math.floor(500 + Math.random() * 1000);
        const sign = Math.random() > 0.5 ? 1 : -1;
        wrongValues = [1, 2, 3].map((multiplier) => {
          const offset = baseModifier * multiplier * sign;
          const calculated = gas + offset;
          return String(
            calculated <= 0 ? Math.abs(calculated) + multiplier : calculated,
          );
        });
        break;
      }
      case "timestamp": {
        const timestamp = randomQuestion.tx.timestamp;
        correctValue = String(timestamp);
        const txDistractors = puzzles
          .filter((tx) => tx.timestamp !== timestamp)
          .sort(() => Math.random() - 0.5)
          .slice(0, 3)
          .map((tx) => String(tx.timestamp));
        const generatedDistractors = Array.from({ length: 3 }, () => {
          const delta =
            (15 + Math.floor(Math.random() * 885)) *
            1000 *
            (Math.random() > 0.5 ? 1 : -1);
          return String(timestamp + delta);
        });
        wrongValues = [...txDistractors, ...generatedDistractors];
        break;
      }
      default:
        return [];
    }

    const uniqueWrongValues = [...new Set(wrongValues)].filter(
      (v) => v !== correctValue,
    );
    const selectedWrongValues = uniqueWrongValues
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);
    return [correctValue, ...selectedWrongValues]
      .sort(() => Math.random() - 0.5)
      .map((value, i) => ({
        label: labels[i],
        value,
        correct: value === correctValue,
      }));
  };

  const generatePuzzle = (puzzles: PaymentsChallengePuzzleProps[]) => {
    const questionTypes = ["totalGas", "timestamp"] as const;
    const availableQuestions = puzzles
      .flatMap((tx, puzzleIndex) =>
        questionTypes.map((questionType) => ({
          tx,
          puzzleIndex,
          questionType,
          key: `${puzzleIndex}-${questionType}`,
        })),
      )
      .filter((question) => !result.usedPuzzles.has(question.key));

    const randomQuestion =
      availableQuestions[Math.floor(Math.random() * availableQuestions.length)];
    const randomAnswers = generateAnswers(puzzles, randomQuestion);
    return { randomQuestion, randomAnswers, puzzles };
  };

  const nextPuzzle = ({
    randomAnswers,
    randomQuestion,
  }: ReturnType<typeof generatePuzzle>) => {
    setResult((prev) => {
      const nextUsed = new Set(prev.usedPuzzles);
      nextUsed.add(randomQuestion.key);
      return {
        round: prev.round + 1,
        usedPuzzles: nextUsed,
        currentPuzzle: { ...randomQuestion, answers: randomAnswers },
      };
    });
  };

  const puzzlesQuery = useQuery({
    queryKey: ["puzzles", tunnel.tunnelId],
    queryFn: async () => {
      const { data } = await suiClient.queryTransactionBlocks({
        limit: 20,
        options: { showInput: true, showEffects: true, showEvents: true },
      });
      return data.map((meta) => ({
        totalGas:
          Number(meta.effects?.gasUsed.computationCost) +
          Number(meta.effects?.gasUsed.storageCost) -
          Number(meta.effects?.gasUsed.storageRebate),
        sender: String(meta.transaction?.data.sender),
        timestamp: Number(meta.timestampMs),
        digest: meta.digest,
      }));
    },
    enabled: isHost,
  });

  useEffect(() => {
    if (isHost && puzzlesQuery.data?.length) {
      const getGeneratePuzzle = generatePuzzle(puzzlesQuery.data);
      nextPuzzle(getGeneratePuzzle);
      setSharedPuzzles(getGeneratePuzzle.puzzles);
      tunnel.channel.sendPeer({
        t: "sync_puzzles",
        ...getGeneratePuzzle,
      } as unknown as Exclude<PeerMessage, { t: "frame" }>);
    }

    tunnel.channel.onPeer((event) => {
      const msg = event as unknown as PaymentPeerMessage;

      if (msg.t === "sync_puzzles") {
        setSharedPuzzles(msg.puzzles);
        nextPuzzle({
          randomQuestion: msg.randomQuestion,
          randomAnswers: msg.randomAnswers,
          puzzles: msg.puzzles,
        });
      }

      if (msg.t === "payment_update") {
        handlePaymentUpdate(msg.nextState, msg.mySig);
      }

      if (msg.t === "game_end") {
        triggerGameEnd();
      }
    });
  }, [isHost, puzzlesQuery.data, tunnel]);

  const handleRoundEnd = () => {
    if (!isHost || !sharedPuzzles.length) return;

    const getGeneratePuzzle = generatePuzzle(sharedPuzzles);
    nextPuzzle(getGeneratePuzzle);

    tunnel.channel.sendPeer({
      t: "sync_puzzles",
      ...getGeneratePuzzle,
    } as unknown as Exclude<PeerMessage, { t: "frame" }>);
  };

  if (!sharedPuzzles?.length) {
    return (
      <div className="space-y-4 p-10 text-center">
        <div className="relative size-16 mx-auto flex items-center justify-center">
          <div className="absolute inset-0 rounded-full bg-violet-500/30 animate-ping" />
          <span className="text-3xl relative z-10">🎯</span>
        </div>
        <div>
          <h2 className="wal-doto text-slate-100 uppercase text-sm">
            Fetching Questions
          </h2>
          <p className="text-xs text-slate-500">
            The system is preparing the challenge...
          </p>
        </div>
        <div className="flex items-center justify-center gap-1.5 text-xs text-slate-600">
          <Loader2Icon className="size-3 animate-spin" />
          <span>Waiting for question</span>
        </div>
      </div>
    );
  }

  if (gameEndCountdown !== null) {
    return (
      <div className="space-y-4 p-10 text-center">
        <div className="relative size-16 mx-auto flex items-center justify-center">
          <span className="text-3xl">🏁</span>
        </div>
        <div>
          <h2 className="wal-doto text-slate-100 uppercase text-sm">
            Game Over
          </h2>
          <p className="text-xs text-slate-500">
            Closing in {gameEndCountdown}s...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex justify-between items-center border border-slate-800 rounded-sm bg-slate-900/50 p-3">
        <PaymentsChallengePlayer
          role={"A"}
          address={tunnel.initialAddress.a}
          amount={payments.balances(paymentStateRef.current).a}
        />
        <div className="text-center">
          <div className="wal-doto text-lg text-yellow-400">VS</div>
          <PaymentsChallengeTime
            created_at={tunnel.created_at}
            onTimeEnd={triggerGameEnd}
          />
        </div>
        <PaymentsChallengePlayer
          role={"B"}
          address={tunnel.initialAddress.b}
          amount={payments.balances(paymentStateRef.current).b}
        />
      </div>

      <div className="border border-border rounded-sm p-3 space-y-3">
        <div className="space-y-2">
          <div className="text-xs font-mono uppercase tracking-widest">
            Round:&nbsp;
            <span className="text-arena-muted">{result.round}/10</span>
          </div>
          <PaymentsChallengeQuestion currentPuzzle={result.currentPuzzle} />
        </div>
        <PaymentsChallengePotential />
      </div>

      <PaymentsChallengeAnswers
        currentPuzzle={result.currentPuzzle}
        currentAddress={currentAccount?.address as string}
        tunnel={tunnel}
        paymentStateRef={paymentStateRef}
        onRoundEnd={handleRoundEnd}
        payments={payments}
        triggerGameEnd={triggerGameEnd}
      />
    </div>
  );
}
