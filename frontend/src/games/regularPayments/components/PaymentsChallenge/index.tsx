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
import PaymentsChallengeQuestion from "./PaymentsChallengeQuestion";
import PaymentsChallengePlayer from "./PaymentsChallengePlayer";
import PaymentsChallengeAnswers, {
  buildCloseMessage,
} from "./PaymentsChallengeAnswers";
import { PaymentsProtocol, PaymentsState } from "sui-tunnel-ts/protocol";
import {
  generatePuzzle,
  nextPuzzle,
  PuzzleCurrentAnswer,
  PuzzlesCurrentState,
} from "../../utils/puzzles";

export interface PaymentsChallengeResultProps {
  round: number;
  usedPuzzles: Set<string>;
  currentPuzzle?: PuzzlesCurrentState & {
    answers: PuzzleCurrentAnswer[];
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
      randomQuestion: PuzzlesCurrentState;
      randomAnswers: PuzzleCurrentAnswer[];
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

  const puzzlesQuery = useQuery<PaymentsChallengePuzzleProps[]>({
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

  // generate puzzle for first time
  useEffect(() => {
    if (isHost && puzzlesQuery.data?.length) {
      const generate = generatePuzzle(puzzlesQuery.data, result.usedPuzzles);

      nextPuzzle({ ...generate, setResult });
      setSharedPuzzles(generate.puzzles);

      // send peer to sync
      tunnel.channel.sendPeer({
        t: "sync_puzzles",
        ...generate,
      } as never);
    }
  }, [isHost, puzzlesQuery.data, tunnel]);

  // update state via onPeer
  useEffect(() => {
    tunnel.channel.onPeer((event) => {
      const msg = event as unknown as PaymentPeerMessage;

      console.log("msg", msg);

      if (msg.t === "sync_puzzles") {
        setSharedPuzzles(msg.puzzles);
        nextPuzzle({ ...msg, setResult });
      }
    });
  }, [tunnel]);

  useEffect(() => {
    console.log("payments", payments);
  }, [payments]);

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
            onTimeEnd={() => {}}
          />
        </div>

        <PaymentsChallengePlayer
          role={"B"}
          address={tunnel.initialAddress.b}
          amount={payments.balances(paymentStateRef.current).b}
        />
      </div>

      <div className="border border-border rounded-sm p-3 space-y-2">
        <div className="text-xs font-mono uppercase tracking-widest">
          Round:&nbsp;
          <span className="text-arena-muted">{result.round}/10</span>
        </div>

        <PaymentsChallengeQuestion currentPuzzle={result.currentPuzzle} />
      </div>

      <PaymentsChallengeAnswers
        isHost={isHost}
        tunnel={tunnel}
        currentPuzzle={result.currentPuzzle}
        payments={payments}
        paymentStateRef={paymentStateRef}
        onNextRound={() => {
          const generate = generatePuzzle(sharedPuzzles, result.usedPuzzles);

          nextPuzzle({ ...generate, setResult });
        }}
      />
    </div>
  );
}
