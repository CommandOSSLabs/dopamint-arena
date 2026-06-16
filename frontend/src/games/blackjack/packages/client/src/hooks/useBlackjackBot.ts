import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, protocols } from "sui-tunnel-ts";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import {
  buildCreateAndShareTx,
  buildDepositTx,
  buildSettleTx,
  parseTunnelId,
} from "@/lib/bjTunnel";
import { handToCardIndices, handValue } from "@/lib/bjCards";
import {
  loadOrCreateBots,
  getSuiClient,
  botBalances,
  fundBots,
  type BotIdentity,
} from "@/lib/bjBots";

type State = protocols.BlackjackState;

export type BotPhase =
  | "idle"
  | "funding"
  | "opening"
  | "playing"
  | "settling"
  | "done"
  | "error";

export interface BotDigests {
  create?: string;
  depositA?: string;
  depositB?: string;
  close?: string;
}

export interface BlackjackBotView {
  playerCards: number[];
  dealerCards: number[];
  playerSum: number;
  dealerSum: number;
  playerBalance: number;
  dealerBalance: number;
  round: number;
  phase: "player" | "dealer" | "round_over";
}

export type BlackjackResult = "win" | "lose" | "push";

export interface BlackjackBotGame {
  view: BlackjackBotView;
  result: BlackjackResult | null;
  phase: BotPhase;
  error: string | null;
  digests: BotDigests;
  balances: { a: bigint; b: bigint };
  auto: boolean;
  fund: () => void;
  startAuto: () => void;
  stopAuto: () => void;
  newGame: () => void;
  refresh: () => Promise<{ a: bigint; b: bigint } | null>;
}

// Each bot stakes this much into the tunnel per game.
const STAKE = 500n;
// Animation cadence: one move surfaced to the view per tick.
const STEP_MS = 700;
// A bot must hold at least this much (gas for its txs + the STAKE deposit) to safely play
// another game; below it, auto-play stops rather than risk a mid-game tx running out of gas
// and leaving a tunnel open. ~0.02 SUI (a game costs the busier bot ~0.01 SUI of gas).
const MIN_PLAY_MIST = 20_000_000n;
// Pause between auto-played games.
const NEXT_GAME_MS = 1200;
// Safety bound: the protocol caps rounds, but never spin forever on a logic bug.
const MAX_STEPS = 5000;

function viewFromState(state: State): BlackjackBotView {
  const round = Number(state.round);
  return {
    playerCards: handToCardIndices(state.playerHand, round * 2),
    dealerCards: handToCardIndices(state.dealerHand, round * 2 + 1),
    playerSum: handValue(state.playerHand),
    dealerSum: handValue(state.dealerHand),
    playerBalance: Number(state.balanceA),
    dealerBalance: Number(state.balanceB),
    round,
    phase: state.phase,
  };
}

const EMPTY_VIEW: BlackjackBotView = {
  playerCards: [],
  dealerCards: [],
  playerSum: 0,
  dealerSum: 0,
  playerBalance: 0,
  dealerBalance: 0,
  round: 0,
  phase: "player",
};

export function useBlackjackBot(): BlackjackBotGame {
  const proto = useMemo(() => new protocols.BlackjackProtocol(), []);
  const bots = useMemo(() => loadOrCreateBots(), []);
  const client = useMemo(() => getSuiClient(), []);

  const [view, setView] = useState<BlackjackBotView>(EMPTY_VIEW);
  const [result, setResult] = useState<BlackjackResult | null>(null);
  const [phase, setPhase] = useState<BotPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [digests, setDigests] = useState<BotDigests>({});
  const [balances, setBalances] = useState<{ a: bigint; b: bigint }>({
    a: 0n,
    b: 0n,
  });
  const [auto, setAuto] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRef = useRef(false); // mirror of `auto` readable inside async flows
  const balancesRef = useRef<{ a: bigint; b: bigint }>({ a: 0n, b: 0n });
  const runRef = useRef<() => void>(() => {});

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const refreshBalances = useCallback(async () => {
    try {
      const b = await botBalances(client, bots);
      balancesRef.current = b;
      setBalances(b);
      return b;
    } catch {
      return null;
    }
  }, [client, bots]);

  // Load balances on mount; tear down timers on unmount.
  useEffect(() => {
    void refreshBalances();
    return () => {
      stopTimer();
      if (nextRef.current !== null) clearTimeout(nextRef.current);
    };
  }, [refreshBalances, stopTimer]);

  // Submit a tx signed by a bot keypair; assert success and return the result.
  const submit = useCallback(
    async (tx: Transaction, signer: Ed25519Keypair) => {
      const res = await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (res.effects?.status?.status !== "success") {
        throw new Error(
          `tx ${res.digest} failed: ${res.effects?.status?.error ?? "unknown"}`,
        );
      }
      await client.waitForTransaction({ digest: res.digest });
      return res;
    },
    [client],
  );

  const fund = useCallback(() => {
    void (async () => {
      setPhase("funding");
      setError(null);
      try {
        await fundBots(client, bots);
        await refreshBalances();
        setPhase("idle");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [client, bots, refreshBalances]);

  // Run exactly one game: create -> 2 deposits -> animated self-play -> cooperative close.
  // When auto-play is on, schedules the next game (or stops if a bot is low on gas).
  const runGame = useCallback(() => {
    stopTimer();
    if (
      balancesRef.current.a < MIN_PLAY_MIST ||
      balancesRef.current.b < MIN_PLAY_MIST
    ) {
      autoRef.current = false;
      setAuto(false);
      setError("Fund the bots first");
      setPhase("error");
      return;
    }
    setError(null);
    setView(EMPTY_VIEW);
    setResult(null);
    setDigests({});

    void (async () => {
      try {
        const partyA = { address: bots.a.address, publicKey: bots.a.publicKey };
        const partyB = { address: bots.b.address, publicKey: bots.b.publicKey };

        // 1) bot A create + share.
        setPhase("opening");
        const createRes = await submit(
          buildCreateAndShareTx(partyA, partyB),
          bots.a.keypair,
        );
        const tunnelId = parseTunnelId(createRes.objectChanges);
        if (!tunnelId) throw new Error("could not find created Tunnel id");
        setDigests((d) => ({ ...d, create: createRes.digest }));

        // 2) read created_at for the settlement timestamp.
        const obj = await client.getObject({
          id: tunnelId,
          options: { showContent: true },
        });
        const fields = (
          obj.data?.content as { fields?: Record<string, unknown> } | undefined
        )?.fields;
        const createdAt = BigInt((fields?.created_at as string | undefined) ?? 0);

        // 3) both bots deposit STAKE.
        const depARes = await submit(
          buildDepositTx(tunnelId, STAKE),
          bots.a.keypair,
        );
        setDigests((d) => ({ ...d, depositA: depARes.digest }));
        const depBRes = await submit(
          buildDepositTx(tunnelId, STAKE),
          bots.b.keypair,
        );
        setDigests((d) => ({ ...d, depositB: depBRes.digest }));

        // 4) off-chain self-play tunnel (both keys held locally).
        const tunnel = core.OffchainTunnel.selfPlay(
          proto,
          tunnelId,
          bots.a.coreKey,
          bots.b.coreKey,
          bots.a.address,
          bots.b.address,
          { a: STAKE, b: STAKE },
        );

        // 5) animate moves; each .step co-signs AND verifies both sigs (mode "full").
        // The dealer ('dealer' phase) moves as B, everyone else as A.
        setPhase("playing");
        setView(viewFromState(tunnel.state));
        await new Promise<void>((resolve, reject) => {
          let steps = 0;
          timerRef.current = setInterval(() => {
            try {
              if (proto.isTerminal(tunnel.state)) {
                stopTimer();
                resolve();
                return;
              }
              if (steps++ >= MAX_STEPS) {
                throw new Error("self-play exceeded step bound");
              }
              const by: protocols.Party =
                tunnel.state.phase === "dealer" ? "B" : "A";
              const move = proto.randomMove(tunnel.state, by, Math.random);
              if (!move) {
                stopTimer();
                resolve();
                return;
              }
              const r = tunnel.step(move, by, { mode: "full" });
              if (!r.verified)
                throw new Error(`state ${r.nonce} failed dual-verify`);
              setView(viewFromState(tunnel.state));
              if (proto.isTerminal(tunnel.state)) {
                stopTimer();
                resolve();
              }
            } catch (err) {
              stopTimer();
              reject(err);
            }
          }, STEP_MS);
        });

        setView(viewFromState(tunnel.state));

        // Result from final balanceA vs STAKE (A is the player bot).
        const finalA = tunnel.state.balanceA;
        const finalResult: BlackjackResult =
          finalA > STAKE ? "win" : finalA < STAKE ? "lose" : "push";
        setResult(finalResult);

        // 6) bot A closes cooperatively from the co-signed settlement.
        setPhase("settling");
        const s = tunnel.buildSettlement(createdAt, 0n);
        const closeRes = await submit(
          buildSettleTx(tunnelId, s),
          bots.a.keypair,
        );
        setDigests((d) => ({ ...d, close: closeRes.digest }));

        const b = await refreshBalances();
        setPhase("done");

        // 7) auto-play: continue until a bot is low on gas, or the user stopped.
        if (autoRef.current) {
          if (b && b.a >= MIN_PLAY_MIST && b.b >= MIN_PLAY_MIST) {
            nextRef.current = setTimeout(() => {
              if (autoRef.current) runRef.current();
            }, NEXT_GAME_MS);
          } else {
            autoRef.current = false;
            setAuto(false);
            setError(
              "A bot is low on gas — auto-play stopped. Fund the bots to continue.",
            );
          }
        }
      } catch (e) {
        stopTimer();
        autoRef.current = false; // never loop on errors
        setAuto(false);
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [bots, client, proto, submit, refreshBalances, stopTimer]);

  // keep a ref to the latest runGame so the auto-play timeout always calls the current one.
  useEffect(() => {
    runRef.current = runGame;
  }, [runGame]);

  const newGame = useCallback(() => {
    autoRef.current = false;
    setAuto(false);
    runGame();
  }, [runGame]);

  const startAuto = useCallback(() => {
    if (
      balancesRef.current.a < MIN_PLAY_MIST ||
      balancesRef.current.b < MIN_PLAY_MIST
    ) {
      setError("Fund the bots first");
      setPhase("error");
      return;
    }
    autoRef.current = true;
    setAuto(true);
    runGame();
  }, [runGame]);

  const stopAuto = useCallback(() => {
    autoRef.current = false;
    setAuto(false);
    if (nextRef.current !== null) {
      clearTimeout(nextRef.current);
      nextRef.current = null;
    }
  }, []);

  return {
    view,
    result,
    phase,
    error,
    digests,
    balances,
    auto,
    fund,
    startAuto,
    stopAuto,
    newGame,
    refresh: refreshBalances,
  };
}

export type { BotIdentity };
