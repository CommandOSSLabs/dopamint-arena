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
import type { BlackjackResult, RoundResult } from "@/hooks/useBlackjackBot";

type State = protocols.BlackjackState;

// Lifecycle of the human-vs-dealer table. Distinct from BotPhase: "playing" here is an
// idle waiting-for-the-human state, not a free-running animation.
export type TablePhase =
  | "idle"
  | "funding"
  | "opening"
  | "playing"
  | "settling"
  | "done"
  | "error";

export interface TableDigests {
  create?: string;
  depositA?: string;
  depositB?: string;
  close?: string;
}

export interface PlayerVsDealerView {
  playerCards: number[];
  dealerCards: number[];
  playerSum: number;
  dealerSum: number;
  playerBalance: number;
  dealerBalance: number;
  round: number;
  phase: protocols.BlackjackPhase;
}

const MAX_ROUNDS_LOGGED = 20;

export interface PlayerVsDealerGame {
  view: PlayerVsDealerView;
  result: BlackjackResult | null;
  rounds: RoundResult[];
  phase: TablePhase;
  error: string | null;
  fundNote: string | null;
  digests: TableDigests;
  balances: { a: bigint; b: bigint };
  isPlayerTurn: boolean;
  isTerminal: boolean;
  fund: () => void;
  pollBalances: (prev?: { a: bigint; b: bigint }) => Promise<void>;
  openTable: () => void;
  hit: () => void;
  stand: () => void;
  nextRound: () => void;
  cashOut: () => void;
}

// Each party stakes this into the tunnel; the human plays for party A.
const STAKE = 500n;
// A short pause so the dealer's auto-drawn cards animate in after the human Stands.
const DEALER_REVEAL_MS = 700;
// A bot must hold at least this much (gas + STAKE deposit) to safely open a table.
const MIN_PLAY_MIST = 20_000_000n;
const POLL_BALANCES_MS = 1500;
const POLL_BALANCES_TRIES = 8;

function viewFromState(state: State): PlayerVsDealerView {
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

const EMPTY_VIEW: PlayerVsDealerView = {
  playerCards: [],
  dealerCards: [],
  playerSum: 0,
  dealerSum: 0,
  playerBalance: 0,
  dealerBalance: 0,
  round: 0,
  phase: "player",
};

type Tunnel = core.OffchainTunnel<State, protocols.BlackjackMove>;

// Human plays party A (Hit/Stand) against an auto-resolving dealer (party B) over the same
// off-chain state channel as the bot arena. Both keys are held locally; every step
// dual-signs+verifies. Unlike the bot hook, moves are driven by the human, not a timer —
// the only timer is the brief dealer-reveal delay after a Stand.
export function usePlayerVsDealer(): PlayerVsDealerGame {
  const proto = useMemo(() => new protocols.BlackjackProtocol(), []);
  const bots = useMemo(() => loadOrCreateBots(), []);
  const client = useMemo(() => getSuiClient(), []);

  const [view, setView] = useState<PlayerVsDealerView>(EMPTY_VIEW);
  const [result, setResult] = useState<BlackjackResult | null>(null);
  const [rounds, setRounds] = useState<RoundResult[]>([]);
  const [phase, setPhase] = useState<TablePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [fundNote, setFundNote] = useState<string | null>(null);
  const [digests, setDigests] = useState<TableDigests>({});
  const [balances, setBalances] = useState<{ a: bigint; b: bigint }>({
    a: 0n,
    b: 0n,
  });
  const [isTerminal, setIsTerminal] = useState(false);

  // Live tunnel + its on-chain handle, held in refs so action callbacks read the latest
  // without re-subscribing. `busy` guards against double-clicks driving an extra step.
  const tunnelRef = useRef<Tunnel | null>(null);
  const tunnelIdRef = useRef<string | null>(null);
  const createdAtRef = useRef<bigint>(0n);
  const balancesRef = useRef<{ a: bigint; b: bigint }>({ a: 0n, b: 0n });
  const dealerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);

  const clearDealerTimer = useCallback(() => {
    if (dealerTimerRef.current !== null) {
      clearTimeout(dealerTimerRef.current);
      dealerTimerRef.current = null;
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

  const pollBalances = useCallback(
    async (prev?: { a: bigint; b: bigint }) => {
      for (let i = 0; i < POLL_BALANCES_TRIES; i++) {
        const b = await refreshBalances();
        if (
          b &&
          (prev ? b.a > prev.a : b.a > 0n) &&
          (prev ? b.b > prev.b : b.b > 0n)
        ) {
          return;
        }
        await new Promise<void>((r) => setTimeout(r, POLL_BALANCES_MS));
      }
    },
    [refreshBalances],
  );

  useEffect(() => {
    void refreshBalances();
    return () => clearDealerTimer();
  }, [refreshBalances, clearDealerTimer]);

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
      setFundNote(null);
      const prev = balancesRef.current;
      try {
        const status = await fundBots(client, bots);
        const failed = [
          status.a !== "ok" ? `Player: ${status.a}` : null,
          status.b !== "ok" ? `Dealer: ${status.b}` : null,
        ].filter(Boolean);
        if (failed.length > 0) {
          setFundNote(
            `Faucet did not fully deliver (${failed.join("; ")}). Try wallet funding or wait and refresh.`,
          );
        }
        await pollBalances(prev);
        setPhase("idle");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [client, bots, pollBalances]);

  // Record the round whose resolution we just stepped into. Mirrors the bot hook's
  // per-round log: delta is A's stake change (>0 win, <0 lose, 0 push).
  const recordRound = useCallback((prevBalanceA: bigint, s: State) => {
    const delta = Number(s.balanceA - prevBalanceA);
    const outcome: BlackjackResult =
      delta > 0 ? "win" : delta < 0 ? "lose" : "push";
    const settled: RoundResult = {
      round: Number(s.round),
      playerSum: handValue(s.playerHand),
      dealerSum: handValue(s.dealerHand),
      outcome,
      delta,
    };
    setRounds((prev) => [...prev, settled].slice(-MAX_ROUNDS_LOGGED));
  }, []);

  // Open the table on-chain: create+share -> read created_at -> both deposits -> build the
  // off-chain self-play tunnel (both keys local). The protocol deals round 1 immediately
  // (phase "player"), so the human can act as soon as we surface the state.
  const openTable = useCallback(() => {
    clearDealerTimer();
    if (
      balancesRef.current.a < MIN_PLAY_MIST ||
      balancesRef.current.b < MIN_PLAY_MIST
    ) {
      setError("Fund the table first");
      setPhase("error");
      return;
    }
    setError(null);
    setView(EMPTY_VIEW);
    setResult(null);
    setRounds([]);
    setDigests({});
    setIsTerminal(false);
    tunnelRef.current = null;
    tunnelIdRef.current = null;

    void (async () => {
      try {
        const partyA = { address: bots.a.address, publicKey: bots.a.publicKey };
        const partyB = { address: bots.b.address, publicKey: bots.b.publicKey };

        setPhase("opening");
        const createRes = await submit(
          buildCreateAndShareTx(partyA, partyB),
          bots.a.keypair,
        );
        const tunnelId = parseTunnelId(createRes.objectChanges);
        if (!tunnelId) throw new Error("could not find created Tunnel id");
        setDigests((d) => ({ ...d, create: createRes.digest }));

        const obj = await client.getObject({
          id: tunnelId,
          options: { showContent: true },
        });
        const fields = (
          obj.data?.content as { fields?: Record<string, unknown> } | undefined
        )?.fields;
        const createdAt = BigInt(
          (fields?.created_at as string | undefined) ?? 0,
        );

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

        const tunnel = core.OffchainTunnel.selfPlay<
          State,
          protocols.BlackjackMove
        >(
          proto,
          tunnelId,
          bots.a.coreKey,
          bots.b.coreKey,
          bots.a.address,
          bots.b.address,
          { a: STAKE, b: STAKE },
        );

        tunnelRef.current = tunnel;
        tunnelIdRef.current = tunnelId;
        createdAtRef.current = createdAt;
        setView(viewFromState(tunnel.state));
        setIsTerminal(proto.isTerminal(tunnel.state));
        // Round 1 is dealt; the human is on the clock.
        setPhase("playing");
        void refreshBalances();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [bots, client, proto, submit, refreshBalances, clearDealerTimer]);

  // Co-signed step as a given party; throws if the dual-verify fails so we never advance
  // on an unverified state.
  const stepBy = useCallback(
    (tunnel: Tunnel, by: protocols.Party) => {
      const r = tunnel.step({ action: "stand" }, by, { mode: "full" });
      if (!r.verified) throw new Error(`state ${r.nonce} failed dual-verify`);
      return tunnel.state;
    },
    [],
  );

  // Human Hit: draw one card for the player. A bust resolves the round immediately
  // (phase -> "round_over") as a loss; we record it.
  const hit = useCallback(() => {
    const tunnel = tunnelRef.current;
    if (!tunnel || busyRef.current) return;
    if (tunnel.state.phase !== "player") return;
    busyRef.current = true;
    try {
      const prevBalanceA = tunnel.state.balanceA;
      const r = tunnel.step({ action: "hit" }, "A", { mode: "full" });
      if (!r.verified) throw new Error(`state ${r.nonce} failed dual-verify`);
      const s = tunnel.state;
      setView(viewFromState(s));
      if (s.phase === "round_over") recordRound(prevBalanceA, s);
      setIsTerminal(proto.isTerminal(s));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      busyRef.current = false;
    }
  }, [proto, recordRound]);

  // Human Stand: end the player's turn (-> "dealer"), then auto-resolve the dealer after a
  // brief reveal pause. The dealer's only legal action is "stand", which triggers its
  // deterministic draw-to-17 and settles the round (-> "round_over").
  const stand = useCallback(() => {
    const tunnel = tunnelRef.current;
    if (!tunnel || busyRef.current) return;
    if (tunnel.state.phase !== "player") return;
    busyRef.current = true;
    try {
      const prevBalanceA = tunnel.state.balanceA;
      const afterStand = stepBy(tunnel, "A"); // phase -> "dealer"
      setView(viewFromState(afterStand));

      clearDealerTimer();
      dealerTimerRef.current = setTimeout(() => {
        dealerTimerRef.current = null;
        try {
          const s = stepBy(tunnel, "B"); // dealer auto-draws + settles
          setView(viewFromState(s));
          if (s.phase === "round_over") recordRound(prevBalanceA, s);
          setIsTerminal(proto.isTerminal(s));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        } finally {
          busyRef.current = false;
        }
      }, DEALER_REVEAL_MS);
    } catch (e) {
      busyRef.current = false;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [proto, stepBy, recordRound, clearDealerTimer]);

  // Deal a fresh round. Per the protocol, any action while "round_over" (and not terminal)
  // advances `round` and re-deals -> phase "player".
  const nextRound = useCallback(() => {
    const tunnel = tunnelRef.current;
    if (!tunnel || busyRef.current) return;
    if (tunnel.state.phase !== "round_over" || proto.isTerminal(tunnel.state))
      return;
    busyRef.current = true;
    try {
      const r = tunnel.step({ action: "hit" }, "A", { mode: "full" });
      if (!r.verified) throw new Error(`state ${r.nonce} failed dual-verify`);
      setView(viewFromState(tunnel.state));
      setIsTerminal(proto.isTerminal(tunnel.state));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      busyRef.current = false;
    }
  }, [proto]);

  // Settle on-chain from the co-signed settlement and close the tunnel. Party A submits.
  // The player's final stake (balanceA) is their payout.
  const cashOut = useCallback(() => {
    const tunnel = tunnelRef.current;
    const tunnelId = tunnelIdRef.current;
    if (!tunnel || !tunnelId || busyRef.current) return;
    clearDealerTimer();
    busyRef.current = true;
    void (async () => {
      try {
        setPhase("settling");
        const finalA = tunnel.state.balanceA;
        setResult(finalA > STAKE ? "win" : finalA < STAKE ? "lose" : "push");

        const settlement = tunnel.buildSettlement(createdAtRef.current, 0n);
        const closeRes = await submit(
          buildSettleTx(tunnelId, settlement),
          bots.a.keypair,
        );
        setDigests((d) => ({ ...d, close: closeRes.digest }));

        // Tunnel is closed; clear the live handle so actions no-op.
        tunnelRef.current = null;
        tunnelIdRef.current = null;
        await refreshBalances();
        setPhase("done");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      } finally {
        busyRef.current = false;
      }
    })();
  }, [bots, submit, refreshBalances, clearDealerTimer]);

  // Once the game is terminal (bankrupt or round cap), auto-cash-out so funds settle
  // on-chain rather than stranding an open tunnel.
  useEffect(() => {
    if (isTerminal && phase === "playing" && tunnelRef.current) {
      cashOut();
    }
  }, [isTerminal, phase, cashOut]);

  const isPlayerTurn =
    phase === "playing" && view.phase === "player" && tunnelRef.current !== null;

  return {
    view,
    result,
    rounds,
    phase,
    error,
    fundNote,
    digests,
    balances,
    isPlayerTurn,
    isTerminal,
    fund,
    pollBalances,
    openTable,
    hit,
    stand,
    nextRound,
    cashOut,
  };
}

export type { BotIdentity };
