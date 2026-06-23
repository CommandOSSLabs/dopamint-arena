import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, proof, protocols, bytesToHex } from "sui-tunnel-ts";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import { getControlPlaneClient, type RegisterSessionResult } from "@/backend/controlPlane";
import { settleViaBackend } from "@/backend/settle";
import {
  buildCreateAndFundTx,
  buildSettleWithRootTx,
  buildUpdateStateTx,
  parseTunnelId,
} from "@/games/blackjack/app/lib/bjTunnel";
import {
  handToCardIndices,
  handValue,
} from "@/games/blackjack/app/lib/bjCards";
import {
  loadOrCreateBots,
  getSuiClient,
  botBalances,
  fundBots,
  type BotIdentity,
} from "@/games/blackjack/app/lib/bjBots";
import {
  DOPAMINT_COIN_TYPE,
  ensureDopamintStakeCoin,
  isDopamintConfigured,
} from "@/onchain/dopamint";
import { makeKeypairSponsoredSignExec } from "@/onchain/sponsor";
import type {
  BlackjackResult,
  RoundResult,
} from "@/games/blackjack/app/hooks/useBlackjackBot";

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
  /** The single open+fund+activate tx (create_and_fund), signed by the player bot. */
  create?: string;
  /** Checkpoint of the final co-signed state (update_state), submitted before close. */
  update?: string;
  close?: string;
  /** Hex of the transcript Merkle root anchored on-chain at close (0x-prefixed). */
  root?: string;
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
  // Transcript of every co-signed update for the live tunnel; its Merkle root is anchored
  // on-chain at cashOut. Lives in a ref so the settle callback reads the same instance.
  const transcriptRef = useRef<proof.Transcript | null>(null);
  const balancesRef = useRef<{ a: bigint; b: bigint }>({ a: 0n, b: 0n });
  const dealerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);

  const sessionRef = useRef<RegisterSessionResult | null>(null);
  const moveCountRef = useRef(0);
  const actionsRef = useRef(0);
  const lastHeartbeatRef = useRef(Date.now());

  const flushHeartbeat = useCallback((tunnelId: string, force: boolean) => {
    const s = sessionRef.current;
    if (!s || actionsRef.current === 0) return;
    const now = Date.now();
    const windowMs = now - lastHeartbeatRef.current;
    if (!force && windowMs < 1000) return;
    const actionsDelta = actionsRef.current;
    actionsRef.current = 0;
    lastHeartbeatRef.current = now;
    getControlPlaneClient()
      .sendHeartbeat(s.sessionId, s.statsToken, {
        tunnelId,
        nonce: String(moveCountRef.current),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => console.error("[blackjack table] heartbeat failed:", e));
  }, []);

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

  // DOPAMINT mode: route a bot keypair's tx through the backend gas sponsor (ADR-0009/0010), so
  // the bot needs zero SUI — the settler pays gas, the bot only signs. Returns just the digest;
  // the create flow re-reads object changes via getTransactionBlock to recover the tunnel id.
  const sponsoredSignExec = useCallback(
    (bot: BotIdentity) =>
      makeKeypairSponsoredSignExec({
        address: bot.address,
        keypair: bot.keypair,
        client: client as never,
      }),
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

  // Open the table on-chain: one create_and_fund (the player bot funds both stakes from its
  // gas, dealer bot signs nothing) -> read created_at -> build the off-chain self-play tunnel
  // (both keys local). The protocol deals round 1 immediately (phase "player"), so the human
  // can act as soon as we surface the state.
  const openTable = useCallback(() => {
    clearDealerTimer();
    // DOPAMINT mode: gas is sponsored and the stake is faucet-minted, so the bots need no SUI —
    // skip the SUI-balance gate (their SUI balance is 0). SUI fallback still requires funded keys.
    if (
      !isDopamintConfigured &&
      (balancesRef.current.a < MIN_PLAY_MIST ||
        balancesRef.current.b < MIN_PLAY_MIST)
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

        // DOPAMINT mode: stake faucet-minted DOPAMINT (both seats funded from one bot-A coin) and
        // sponsor the bot's open/close gas (no SUI). SUI fallback: bot A funds the stakes from its
        // own gas coin and pays its own gas.
        const coinType = isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined;
        const stakeCoinId = isDopamintConfigured
          ? await ensureDopamintStakeCoin({
              client: client as never,
              signExec: sponsoredSignExec(bots.a),
              owner: bots.a.address,
              need: 2n * STAKE,
            })
          : undefined;

        setPhase("opening");
        let createDigest: string;
        if (isDopamintConfigured) {
          const { digest } = await sponsoredSignExec(bots.a)(
            buildCreateAndFundTx(partyA, partyB, STAKE, {
              coinType,
              stakeCoinId,
            }),
          );
          await client.waitForTransaction({ digest });
          createDigest = digest;
        } else {
          const createRes = await submit(
            buildCreateAndFundTx(partyA, partyB, STAKE),
            bots.a.keypair,
          );
          createDigest = createRes.digest;
        }
        const createTxb = await client.getTransactionBlock({
          digest: createDigest,
          options: { showObjectChanges: true },
        });
        const tunnelId = parseTunnelId(createTxb.objectChanges);
        if (!tunnelId) throw new Error("could not find created Tunnel id");
        setDigests((d) => ({ ...d, create: createDigest }));

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

        // Capture every co-signed update before any step so the anchored root is complete.
        const transcript = new proof.Transcript(tunnelId);
        tunnel.onUpdate = (u) => transcript.append(u);

        // Register the (real, on-chain) tunnel for stats tracking. Best-effort.
        sessionRef.current = null;
        moveCountRef.current = 0;
        actionsRef.current = 0;
        lastHeartbeatRef.current = Date.now();
        getControlPlaneClient()
          .registerSession({
            userAddress: bots.a.address,
            game: "blackjack",
            tunnels: [{ tunnelId, partyA: bots.a.address, partyB: bots.b.address }],
          })
          .then((s) => {
            sessionRef.current = s;
          })
          .catch((e) => console.error("[blackjack table] registerSession failed:", e));

        tunnelRef.current = tunnel;
        tunnelIdRef.current = tunnelId;
        transcriptRef.current = transcript;
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
  }, [bots, client, proto, submit, sponsoredSignExec, refreshBalances, clearDealerTimer]);

  // Co-signed step as a given party; throws if the dual-verify fails so we never advance
  // on an unverified state.
  const stepBy = useCallback((tunnel: Tunnel, by: protocols.Party) => {
    // Sign with the on-chain created_at so the final co-signed state passes
    // update_state's timestamp check at cashOut (see hit/nextRound for the same).
    const r = tunnel.step({ action: "stand" }, by, {
      mode: "full",
      timestamp: createdAtRef.current,
    });
    if (!r.verified) throw new Error(`state ${r.nonce} failed dual-verify`);
    return tunnel.state;
  }, []);

  // Human Hit: draw one card for the player. A bust resolves the round immediately
  // (phase -> "round_over") as a loss; we record it.
  const hit = useCallback(() => {
    const tunnel = tunnelRef.current;
    if (!tunnel || busyRef.current) return;
    if (tunnel.state.phase !== "player") return;
    busyRef.current = true;
    try {
      const prevBalanceA = tunnel.state.balanceA;
      const r = tunnel.step({ action: "hit" }, "A", {
        mode: "full",
        timestamp: createdAtRef.current,
      });
      if (!r.verified) throw new Error(`state ${r.nonce} failed dual-verify`);
      moveCountRef.current += 1;
      actionsRef.current += 1;
      const s = tunnel.state;
      setView(viewFromState(s));
      if (s.phase === "round_over") recordRound(prevBalanceA, s);
      setIsTerminal(proto.isTerminal(s));
      flushHeartbeat(tunnelIdRef.current!, false);
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
      moveCountRef.current += 1;
      actionsRef.current += 1;
      setView(viewFromState(afterStand));
      flushHeartbeat(tunnelIdRef.current!, false);

      clearDealerTimer();
      dealerTimerRef.current = setTimeout(() => {
        dealerTimerRef.current = null;
        try {
          const s = stepBy(tunnel, "B"); // dealer auto-draws + settles
          moveCountRef.current += 1;
          actionsRef.current += 1;
          setView(viewFromState(s));
          if (s.phase === "round_over") recordRound(prevBalanceA, s);
          setIsTerminal(proto.isTerminal(s));
          flushHeartbeat(tunnelIdRef.current!, false);
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
      const r = tunnel.step({ action: "hit" }, "A", {
        mode: "full",
        timestamp: createdAtRef.current,
      });
      if (!r.verified) throw new Error(`state ${r.nonce} failed dual-verify`);
      moveCountRef.current += 1;
      actionsRef.current += 1;
      setView(viewFromState(tunnel.state));
      setIsTerminal(proto.isTerminal(tunnel.state));
      flushHeartbeat(tunnelIdRef.current!, false);
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
    const transcript = transcriptRef.current;
    if (!tunnel || !tunnelId || !transcript || busyRef.current) return;
    clearDealerTimer();
    busyRef.current = true;
    void (async () => {
      try {
        setPhase("settling");
        const finalA = tunnel.state.balanceA;
        setResult(finalA > STAKE ? "win" : finalA < STAKE ? "lose" : "push");
        flushHeartbeat(tunnelId, true);

        const root = transcript.root();
        const settlement = tunnel.buildSettlementWithRoot(
          createdAtRef.current,
          root,
          0n,
        );

        // Backend /settle sponsors the close server-side. The fallback wallet/bot close needs the
        // tunnel's coin type (DOPAMINT when configured), and signs sponsored so the bot needs no SUI.
        const coinType = isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined;
        let closeDigest = "";
        const backendDigest = await settleViaBackend({
          tunnelId,
          settlement,
          transcript: transcript.toRecord().entries,
          label: "blackjack",
          fallbackClose: async () => {
            if (isDopamintConfigured) {
              const { digest } = await sponsoredSignExec(bots.a)(
                buildSettleWithRootTx(tunnelId, settlement, coinType),
              );
              await client.waitForTransaction({ digest });
              closeDigest = digest;
            } else {
              const closeRes = await submit(
                buildSettleWithRootTx(tunnelId, settlement),
                bots.a.keypair,
              );
              closeDigest = closeRes.digest;
            }
          },
        });

        // Backend /settle returns its close digest; the fallback assigns its own (above).
        if (backendDigest) closeDigest = backendDigest;

        setDigests((d) => ({
          ...d,
          close: closeDigest,
          root: `0x${bytesToHex(root)}`,
        }));

        // Tunnel is closed; clear the live handles so actions no-op.
        tunnelRef.current = null;
        tunnelIdRef.current = null;
        transcriptRef.current = null;
        await refreshBalances();
        setPhase("done");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      } finally {
        busyRef.current = false;
      }
    })();
  }, [bots, client, submit, sponsoredSignExec, refreshBalances, clearDealerTimer]);

  // Once the game is terminal (bankrupt or round cap), auto-cash-out so funds settle
  // on-chain rather than stranding an open tunnel.
  useEffect(() => {
    if (isTerminal && phase === "playing" && tunnelRef.current) {
      cashOut();
    }
  }, [isTerminal, phase, cashOut]);

  const isPlayerTurn =
    phase === "playing" &&
    view.phase === "player" &&
    tunnelRef.current !== null;

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
