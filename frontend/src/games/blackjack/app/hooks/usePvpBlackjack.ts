import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, proof, bytesToHex, hexToBytes } from "sui-tunnel-ts";
import { settleViaBackend } from "@/backend/settle";
import { defaultAuto, rememberAuto } from "@/pvp/autoPreference";
import { canSafelyPlayNextEpisode } from "sui-tunnel-ts/proof/limits";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { getSuiClient } from "@/games/blackjack/app/lib/bjBots";
import { getOrCreateEphemeral } from "@/games/blackjack/app/lib/bjPvpIdentity";
import {
  buildCreateAndShareTx,
  buildDepositTx,
  buildCloseTx,
  buildCloseWithRootTx,
  parseTunnelId,
} from "@/games/blackjack/app/lib/bjPvpOnchain";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { withSponsorFallback } from "@/onchain/sponsor";
import {
  MTPS_COIN_TYPE,
  isMtpsAddressBalance,
  isMtpsConfigured,
} from "@/onchain/mtps";
import { handValue as bjCardsHandValue } from "@/games/blackjack/app/lib/bjCards";
import {
  MpClient,
  resolveMpWsUrl,
  type MatchInfo,
  type PeerMessage,
  type PvpChannel,
} from "@/pvp/mpClient";
import { attachResume, resumeActiveTunnels } from "@/pvp/resumeSession";
import {
  raiseDisputeUnilateral,
  submitRebuildingOnStale,
} from "@/onchain/tunnelTx";
import { makeBlackjackResumeAdapter } from "@/games/blackjack/blackjackResumeAdapter";
import {
  installResumePersistence,
  evictExpiredRecords,
  readResumeRecord,
  clearResumeRecord,
} from "@/pvp/resume";
import {
  BlackjackProtocol,
  actorFor,
  getPlayerParty,
  getDealerParty,
  blackjackHandValue as handValue,
  MIN_BET,
  maxBet as tableMaxBet,
  type BlackjackState,
  type BlackjackMove,
} from "sui-tunnel-ts/protocol/blackjack";
import { blackjackMoveCodec } from "sui-tunnel-ts/protocol/blackjackCodec";
import { BET_OPTIONS, bjBetMove } from "@/games/blackjack/app/lib/bjBet";
import type { KeyPair } from "sui-tunnel-ts/core/crypto";
import type { ArenaAllocation } from "@/onchain/arenaEnter";
import {
  consumeArenaEntry,
  subscribeArena,
} from "@/onchain/arenaAllocationStore";

/** Backend arena/`profile_for` id (= the FE registry id; single token, same both ways). Single source
 *  of truth for the arena-store consumer (below) and `GameModule.arenaGameId` (index.ts). */
export const BLACKJACK_ARENA_GAME_ID = "blackjack";

// MP relay base (resolveMpWsUrl appends /v1/mp). Prefer an explicit VITE_MP_URL; otherwise derive
// from the backend base, and when that's empty (same-origin production build) from the page
// origin. Never hardcode localhost — a deployed https site would try ws://127.0.0.1 and fail.
const MP_URL =
  import.meta.env.VITE_MP_URL ||
  (
    import.meta.env.VITE_BACKEND_URL ||
    (typeof location !== "undefined"
      ? location.origin
      : "http://127.0.0.1:8080")
  ).replace(/^http/, "ws");
/** Default buy-in (bankroll) deposited on-chain per seat — whole MTPS (0-decimal; ADR-0023), shown
 *  1:1 as chips. Each player chooses their own before matchmaking; the bet protocol caps each round
 *  at min(both balances). */
const DEFAULT_STAKE = 100n;
/** Buy-in options offered before "Find match" — whole MTPS (0-decimal), shown 1:1 as chips. Stacks
 *  big enough for many rounds (min-bet 1, bet options up to 10); each fits a single faucet pull. */
const FUND_OPTIONS = [100, 250, 500] as const;
const BOT_MOVE_MS = 700; // player auto-bot move cadence
const NEXT_MS = 900; // pause before auto-dealing the next round
const DEFAULT_BET = Number(MIN_BET); // auto's starting bet until the player picks one

/** Pacing for auto-driven commit/reveal plumbing moves (ms). */
const PLUMBING_MS = 120;
// Flat-out auto pacing: in-match auto moves/rounds fire on the next tick (0ms still defers, so the
// confirmed-update sync runs first); the inter-match requeue keeps a short glimpse. Manual play
// still uses BOT_MOVE_MS / NEXT_MS / PLUMBING_MS above.
const AUTO_MOVE_MS = 0;
const AUTO_REQUEUE_MS = 150;

/**
 * Conservative upper bound on the tunnel updates one blackjack round costs (bets, hits,
 * dealer play, plus commit/reveal plumbing). Feeds canSafelyPlayNextEpisode so a series
 * settles at a round boundary while there is still room under MAX_MOVES_PER_TUNNEL,
 * rather than overrunning the cap mid-round. Must exceed the true worst case.
 */
const BLACKJACK_MAX_MOVES_PER_ROUND = 30;

export type PvpPhase =
  | "idle"
  | "connecting"
  | "queuing"
  | "opening"
  | "funding"
  | "playing"
  | "settling"
  | "done"
  | "error";

export interface RoundResult {
  round: number;
  outcome: "win" | "lose" | "push"; // from the PLAYER's perspective
  playerSum: number;
  dealerSum: number;
}

export interface PvpView {
  phase: PvpPhase;
  error: string | null;
  role: "A" | "B" | null; // A = player (draws), B = dealer (host/auto)
  isDealer: boolean;
  playerHand: number[];
  dealerHand: number[]; // dealer hole card hidden until the dealer's turn / round over
  playerSum: number;
  dealerSum: number;
  balancePlayer: bigint; // balance of the seat currently playing the "Player" role
  balanceDealer: bigint; // balance of the seat currently playing the "Dealer" role
  myBalance: bigint; // my persistent balance
  oppBalance: bigint; // opponent's persistent balance
  round: number;
  gamePhase: "draw_commit" | "draw_reveal" | "player" | "round_over" | null;
  myTurn: boolean; // I'm the player and it's the player's turn (Hit/Stand)
  inRoundOver: boolean; // round resolved — can Next / Stop
  terminal: boolean; // round cap or a side can't fund — forces an auto-settle
  outOfChips: "player" | "dealer" | null; // a side can't cover the minimum bet → forced settle
  currentBet: bigint; // the bet locked for the round in progress (0 between rounds before betting)
  tableMax: bigint; // largest bet both sides can cover this round
  betOptions: number[]; // chip denominations the player may bet now (filtered to ≤ tableMax)
  rounds: RoundResult[];
  auto: boolean;
  stake: bigint; // this seat's chosen buy-in (locked once a match starts)
  fundOptions: number[]; // buy-in choices offered before matchmaking
  walletAddress: string;
  walletBalance: bigint;
  digests: { create?: string; deposit?: string; close?: string };
  fund: () => void;
  setStake: (amount: bigint) => void;
  queue: () => void;
  hit: () => void;
  stand: () => void;
  bet: (amount: number) => void; // player places the next round's bet (deals the round)
  stop: () => void;
  setAuto: (on: boolean) => void;
  leave: () => void;
}

export function usePvpBlackjack(): PvpView {
  const client = useMemo<SuiJsonRpcClient>(() => getSuiClient(), []);
  const account = useCurrentAccount();
  const walletAddress = account?.address ?? "";
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();
  const proto = useMemo(() => new BlackjackProtocol(), []);

  const [phase, setPhase] = useState<PvpPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"A" | "B" | null>(null);
  const [state, setState] = useState<BlackjackState | null>(null);
  const [rounds, setRounds] = useState<RoundResult[]>([]);
  // Auto is OFF on a fresh page load (you play your own seat), then sticky to your last toggle —
  // tick it on and new games keep a bot playing for you. See autoPreference.
  const [auto, setAutoState] = useState(() => defaultAuto("blackjack"));
  const [stake, setStakeState] = useState<bigint>(DEFAULT_STAKE);
  const [walletBalance, setWalletBalance] = useState<bigint>(0n);
  const [digests, setDigests] = useState<{
    create?: string;
    deposit?: string;
    close?: string;
  }>({});

  const mpRef = useRef<MpClient | null>(null);
  const channelRef = useRef<PvpChannel | null>(null);
  const detachResumeRef = useRef<(() => void) | null>(null);
  const tunnelRef = useRef<core.DistributedTunnel<
    BlackjackState,
    BlackjackMove
  > | null>(null);
  const roleRef = useRef<"A" | "B" | null>(null);
  const autoRef = useRef(defaultAuto("blackjack"));
  const autoKickedRef = useRef(false);
  const lastBetRef = useRef<number>(DEFAULT_BET); // remembered bet for auto rounds; set on every player bet
  const stakeRef = useRef<bigint>(DEFAULT_STAKE); // chosen buy-in, read inside onMatch without stale closures
  const createdAtRef = useRef<bigint>(0n);
  const matchIdRef = useRef<string>("");
  const settledRef = useRef(false);
  const stoppingRef = useRef(false);
  const onMatchRef =
    useRef<(mp: MpClient, m: MatchInfo) => Promise<void>>(undefined);
  const openedResolveRef = useRef<((id: string) => void) | null>(null);
  const settleResolveRef = useRef<
    ((val: { sig: Uint8Array; root: Uint8Array }) => void) | null
  >(null);
  const bufferedSettleRef = useRef<{
    sig: Uint8Array;
    root: Uint8Array;
  } | null>(null);
  const stakeResolveRef = useRef<((amount: bigint) => void) | null>(null);
  const bufferedStakeRef = useRef<bigint | null>(null);
  const helloResolveRef = useRef<((pub: string) => void) | null>(null);
  const bufferedHelloRef = useRef<string | null>(null);

  const transcriptRef = useRef<proof.Transcript | null>(null);

  const refreshBalance = useCallback(async () => {
    try {
      const b = await client.getBalance({ owner: walletAddress });
      setWalletBalance(BigInt(b.totalBalance));
    } catch {
      /* ignore */
    }
  }, [client, walletAddress]);
  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  // Register the pagehide/visibility flush and evict stale resume records once, on mount.
  useEffect(() => {
    installResumePersistence();
    evictExpiredRecords();
  }, []);

  const submit = useCallback(
    async (tx: any) => {
      const { digest } = await signAndExecute({ transaction: tx });
      const res = await client.waitForTransaction({
        digest,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (res.effects?.status?.status !== "success")
        throw new Error(res.effects?.status?.error ?? "tx failed");
      return res;
    },
    [client, signAndExecute],
  );

  // Sponsored submit (ADR-0009/0010): route the open/deposit tx through the backend gas sponsor —
  // the settler pays gas, the stake stays a MTPS coin. signExec returns only a digest, so we
  // re-read the receipt (object changes + status) for the same downstream handling as `submit`.
  const submitSponsored = useCallback(
    async (tx: any) => {
      const { digest } = await sponsored.signExec(tx);
      const res = await client.waitForTransaction({
        digest,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (res.effects?.status?.status !== "success")
        throw new Error(res.effects?.status?.error ?? "tx failed");
      return res;
    },
    [client, sponsored],
  );

  const fund = useCallback(() => {
    void (async () => {
      if (!walletAddress) {
        setError("Connect a wallet on the menu first");
        return;
      }
      try {
        const { requestSuiFromFaucetV2, getFaucetHost } =
          await import("@mysten/sui/faucet");
        await requestSuiFromFaucetV2({
          host: getFaucetHost("testnet"),
          recipient: walletAddress,
        });
        for (let i = 0; i < 8; i++) {
          await refreshBalance();
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [walletAddress, refreshBalance]);

  // Pick this seat's buy-in (only meaningful before a match; locked once playing).
  const setStake = useCallback((amount: bigint) => {
    stakeRef.current = amount;
    setStakeState(amount);
  }, []);

  const finishSettle = useCallback(
    async (
      t: core.DistributedTunnel<BlackjackState, BlackjackMove>,
      channel: PvpChannel,
      _matchId: string,
    ) => {
      if (settledRef.current) return;
      settledRef.current = true;
      setPhase("settling");
      const root = transcriptRef.current
        ? transcriptRef.current.root()
        : new Uint8Array(32);
      const half = t.buildSettlementHalfWithRoot(
        createdAtRef.current,
        root,
        0n,
      );
      channel.sendPeer({
        t: "settleHalf",
        partyABalance: half.settlement.partyABalance.toString(),
        partyBBalance: half.settlement.partyBBalance.toString(),
        finalNonce: half.settlement.finalNonce.toString(),
        timestamp: half.settlement.timestamp.toString(),
        transcriptRoot: bytesToHex(root),
        sig: bytesToHex(half.sigSelf),
      });
      const other =
        bufferedSettleRef.current ??
        (await new Promise<{ sig: Uint8Array; root: Uint8Array }>((res) => {
          settleResolveRef.current = res;
        }));
      if (bytesToHex(other.root) !== bytesToHex(root)) {
        throw new Error("Transcript root mismatch between players");
      }
      const coSigned = t.combineSettlementWithRoot(
        half.settlement,
        half.sigSelf,
        other.sig,
      );
      // Single submitter = seat A — unified with every other game and the fleet bot, which co-signs
      // the `settleHalf` and never submits. In the arena the human is always A; the bot (dealer/B)
      // can't submit. Payout is fixed by the co-signed balances regardless of who sends the tx.
      if (roleRef.current === "A") {
        const closeDigest = await settleViaBackend({
          tunnelId: t.tunnelId,
          settlement: coSigned as any,
          transcript: transcriptRef.current
            ? transcriptRef.current.rawEntries()
            : [],
          label: "blackjack",
          fallbackClose: async () => {
            // Wallet-close fallback needs the tunnel's coin type (MTPS when configured); the
            // /settle path above already sponsored the close server-side. In MTPS mode the dealer
            // holds 0 SUI (gas is sponsored), so the close must route through the gas sponsor too — a
            // wallet-signed close would throw and strand the staked MTPS.
            const coinType = isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
            const res = await (isMtpsConfigured ? submitSponsored : submit)(
              buildCloseWithRootTx(t.tunnelId, coSigned, coinType),
            );
            return res.digest;
          },
        });
        // Record the close + signal the opponent on BOTH paths (backend digest or fallback digest).
        if (closeDigest) {
          setDigests((d) => ({ ...d, close: closeDigest }));
          channel.sendPeer({ t: "closed", digest: closeDigest });
        }
      }
      await refreshBalance();
      // The tunnel is now closed on-chain; its resume record is dead — drop it so it can't be
      // restored and hijack the next match (resumeActiveTunnels would otherwise glue the next
      // queue to this peerless tunnel, leaving moves un-ACKed).
      clearResumeRecord(t.tunnelId);
      setPhase("done");
    },
    [submit, submitSponsored, refreshBalance],
  );

  // Wire the per-round loop + resume onto a freshly built/rebuilt tunnel. Shared by the live
  // (onMatch) and cold-load (queue) paths so both get identical onConfirmed + attachResume wiring.
  const activateSession = useCallback(
    (
      mp: MpClient,
      channel: PvpChannel,
      t: core.DistributedTunnel<BlackjackState, BlackjackMove>,
      info: {
        matchId: string;
        role: "A" | "B";
        opponentWallet: string;
        opponentPubkeyHex: string;
        selfEphemeralSecretHex: string;
      },
    ) => {
      tunnelRef.current = t;
      channelRef.current = channel;
      // Per-round log: record the player's (party A) result's updates.
      let lastLoggedRound = 0;
      // Initialize from the live checkpoint so the first delta is correct for both the live
      // and cold-load paths (a rebuilt tunnel resumes mid-game, not from the starting stake).
      let lastBalanceA = Number(t.state.balanceA);
      const onAdvance = () => {
        const st = t.state;
        setState({ ...st });
        if (st.phase === "round_over" && Number(st.round) > lastLoggedRound) {
          const balA = Number(st.balanceA);
          const delta = balA - lastBalanceA;
          const outcome: RoundResult["outcome"] =
            delta > 0 ? "win" : delta < 0 ? "lose" : "push";
          const rr: RoundResult = {
            round: Number(st.round),
            outcome,
            playerSum: bjCardsHandValue(st.playerHand),
            dealerSum: bjCardsHandValue(st.dealerHand),
          };
          setRounds((prev) => [...prev, rr].slice(-30));
          lastLoggedRound = Number(st.round);
          lastBalanceA = balA;
        }
        if (stoppingRef.current) return; // a stop/settle is in progress
        // Settle at match end, or early at a clean round boundary when the tunnel is too
        // close to its move ceiling to safely play another round.
        if (
          proto.isTerminal(st) ||
          (st.phase === "round_over" &&
            !canSafelyPlayNextEpisode(
              Number(t.nonce),
              BLACKJACK_MAX_MOVES_PER_ROUND,
            ))
        ) {
          void finishSettle(t, channel, info.matchId);
          return;
        }

        const owed = actorFor(st, getPlayerParty); // PvP: default rotation
        if (!owed) return;
        // Plumbing (commit/reveal) is ALWAYS auto-driven by this seat when it owes it.
        if (
          (st.phase === "draw_commit" || st.phase === "draw_reveal") &&
          owed === info.role
        ) {
          const mv = proto.randomMove(st, info.role, Math.random); // mints commit secret / reveals
          if (mv)
            setTimeout(
              () => {
                try {
                  t.propose(mv, BigInt(Date.now()));
                } catch {
                  /* in flight */
                }
              },
              autoRef.current ? AUTO_MOVE_MS : PLUMBING_MS,
            );
          return;
        }
        // Bet: only the next player bets; auto reuses the remembered bet.
        if (
          st.phase === "round_over" &&
          owed === info.role &&
          autoRef.current
        ) {
          const mv = bjBetMove(lastBetRef.current ?? Number(MIN_BET), st);
          setTimeout(
            () => {
              try {
                t.propose(mv, BigInt(Date.now()));
              } catch {
                /* raced / in flight */
              }
            },
            autoRef.current ? AUTO_MOVE_MS : NEXT_MS,
          );
          return;
        }
        // Player hit/stand: auto mode lets the bot play this seat.
        if (st.phase === "player" && owed === info.role && autoRef.current) {
          const mv = proto.randomMove(st, info.role, Math.random);
          if (mv)
            setTimeout(
              () => {
                try {
                  t.propose(mv, BigInt(Date.now()));
                } catch {
                  /* not my turn / in flight */
                }
              },
              autoRef.current ? AUTO_MOVE_MS : BOT_MOVE_MS,
            );
        }
      };
      t.onConfirmed = (u) => {
        transcriptRef.current?.append(u);
        onAdvance();
      };
      // Resume wiring: persist on confirm + run the resync handshake on reconnect.
      detachResumeRef.current?.();
      detachResumeRef.current = attachResume({
        mp,
        channel,
        tunnel: t,
        adapter: makeBlackjackResumeAdapter({
          getSecret: () => ({
            localSecretA: t.state.localSecretA,
            localSecretB: t.state.localSecretB,
          }),
          setSecret: (sec) => {
            t.state.localSecretA = sec.localSecretA;
            t.state.localSecretB = sec.localSecretB;
          },
          onReconciled: () => onAdvance(),
        }),
        identity: {
          matchId: info.matchId,
          tunnelId: t.tunnelId,
          role: info.role,
          game: "blackjack",
          opponentWallet: info.opponentWallet,
          opponentPubkeyHex: info.opponentPubkeyHex,
          selfEphemeralSecretHex: info.selfEphemeralSecretHex,
        },
        // Settlement floor: after the 1h grace, settle from the held checkpoint.
        onGraceExpired: (latest) => {
          if (latest)
            void raiseDisputeUnilateral({
              signExec: submit,
              tunnelId: t.tunnelId,
              update: latest,
              role: info.role,
            });
        },
      });
      setPhase("playing");
      setState({ ...t.state });
      onAdvance(); // kick off (deal already dealt round 1 -> player phase)
    },
    [proto, submit, finishSettle],
  );

  const queue = useCallback(() => {
    void (async () => {
      if (!walletAddress) {
        setError("Connect a wallet on the menu first");
        setPhase("error");
        return;
      }
      setError(null);
      setPhase("connecting");
      settledRef.current = false;
      stoppingRef.current = false;
      setRounds([]);
      autoKickedRef.current = false;
      // Fresh match resets Auto to the session default (ON the first time, else your last toggle).
      autoRef.current = defaultAuto("blackjack");
      setAutoState(autoRef.current);
      bufferedSettleRef.current = null;
      bufferedStakeRef.current = null;
      bufferedHelloRef.current = null;
      openedResolveRef.current = null;
      settleResolveRef.current = null;
      stakeResolveRef.current = null;
      helloResolveRef.current = null;
      try {
        const connEph = core.generateKeyPair();
        const mp = new MpClient(resolveMpWsUrl(MP_URL), walletAddress, connEph);
        mpRef.current = mp;
        // Cold-load: rebuild any persisted in-flight blackjack match before joining a queue.
        installResumePersistence();
        const restored = resumeActiveTunnels<BlackjackState, BlackjackMove>(
          mp,
          "blackjack",
          {
            proto,
            moveCodec: blackjackMoveCodec,
            adapter: makeBlackjackResumeAdapter({
              getSecret: () => ({ localSecretA: null, localSecretB: null }),
              setSecret: () => {},
              onReconciled: () => {},
            }),
          },
          { selfWallet: walletAddress },
        );
        if (restored.length > 0) {
          const { tunnel, channel } = restored[0];
          const rec = readResumeRecord(tunnel.tunnelId)!;
          matchIdRef.current = rec.matchId;
          roleRef.current = rec.role;
          setRole(rec.role);
          activateSession(mp, channel, tunnel, {
            matchId: rec.matchId,
            role: rec.role,
            opponentWallet: rec.opponentWallet,
            opponentPubkeyHex: rec.opponentPubkeyHex,
            selfEphemeralSecretHex: rec.selfEphemeralSecretHex!,
          });
          await mp.connect();
          return; // skip quickMatch — continuing an in-flight match
        }
        await mp.connect();
        setPhase("queuing");
        const m = await mp.quickMatch("blackjack");
        await onMatchRef.current?.(mp, m);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [walletAddress, proto, activateSession]);

  const onMatch = useCallback(
    async (mp: MpClient, m: MatchInfo) => {
      try {
        matchIdRef.current = m.matchId;
        roleRef.current = m.role;
        setRole(m.role);
        // One channel per match: both the engine transport and the peer side-channel come from it.
        const channel = mp.channel(m.matchId);
        channelRef.current = channel;
        // Peer-channel dispatcher: hello pubkey, opened tunnelId, settle half, stake, closed, stop.
        channel.onPeer((mm: Exclude<PeerMessage, { t: "frame" }>) => {
          if (mm.t === "hello") {
            const pub = String(mm.ephemeralPubkey);
            if (helloResolveRef.current) helloResolveRef.current(pub);
            else bufferedHelloRef.current = pub;
          } else if (mm.t === "opened")
            openedResolveRef.current?.(String(mm.tunnelId));
          else if (mm.t === "settleHalf") {
            const sig = hexToBytes(String(mm.sig));
            const rt = hexToBytes(String(mm.transcriptRoot));
            if (settleResolveRef.current)
              settleResolveRef.current({ sig, root: rt });
            else bufferedSettleRef.current = { sig, root: rt };
          } else if (mm.t === "stake") {
            const amt = BigInt(Math.floor(Number(mm.amount)));
            if (stakeResolveRef.current) stakeResolveRef.current(amt);
            else bufferedStakeRef.current = amt;
          } else if (mm.t === "closed")
            setDigests((d) => ({ ...d, close: String(mm.digest) }));
          else if (mm.t === "stop") {
            stoppingRef.current = true;
            if (tunnelRef.current)
              void finishSettle(tunnelRef.current, channel, m.matchId);
          }
        });

        // The per-match tunnel signing key is keyed by matchId (NOT the connection key).
        const myEph = await getOrCreateEphemeral(m.matchId);
        // hello carries the single move-signer pubkey (no attestation): buffer races.
        channel.sendPeer({ t: "hello", ephemeralPubkey: myEph.pubkeyHex });
        const oppHello =
          bufferedHelloRef.current ??
          (await new Promise<string>((res) => {
            helloResolveRef.current = res;
          }));
        // Opponent's move-signer pubkey. Their on-chain party is m.opponentWallet (self-asserted
        // in v1); the two are deliberately unrelated keys, so there's no address derivation.
        const oppEphPubkey = hexToBytes(oppHello);

        // Exchange chosen buy-ins so both seats agree on the (possibly asymmetric) starting balances.
        const myStake = stakeRef.current;
        channel.sendPeer({ t: "stake", amount: Number(myStake) });
        const oppStake =
          bufferedStakeRef.current ??
          (await new Promise<bigint>((res) => {
            stakeResolveRef.current = res;
          }));
        // Party A is always the player, party B the dealer — independent of who deposits which buy-in.
        const stakeA = m.role === "A" ? myStake : oppStake; // player's buy-in
        const stakeB = m.role === "B" ? myStake : oppStake; // dealer's buy-in
        const penalty = stakeA < stakeB ? stakeA : stakeB; // unused on cooperative close; keep ≤ both deposits

        // MTPS path (ADR-0010): open/fund sponsored, staking the faucet token; SUI path keeps a
        // sender-pays fallback. `coinType` also threads into the wallet-close fallback (the backend
        // /settle close is sponsored server-side).
        const coinType = isMtpsConfigured ? MTPS_COIN_TYPE : undefined;

        // Roles: A = player (party A), B = dealer (party B). The DEALER (role B) opens the tunnel
        // and registers partyA = the player (the opponent), partyB = the dealer (self).
        let tunnelId: string;
        if (m.role === "B") {
          setPhase("opening");
          const openA = {
            walletAddress: m.opponentWallet,
            ephemeralPubkey: oppEphPubkey,
          }; // partyA = player
          const openB = {
            walletAddress,
            ephemeralPubkey: myEph.coreKey.publicKey,
          }; // partyB = dealer (self)
          // create_and_share carries no coin (penalty is a parameter, deposits come later), so it's
          // identical sponsored or sender-pays — route it sponsored when MTPS for a 0-SUI dealer.
          const res = isMtpsConfigured
            ? await submitSponsored(
                buildCreateAndShareTx(openA, openB, penalty, coinType),
              )
            : await submit(buildCreateAndShareTx(openA, openB, penalty));
          const id = parseTunnelId(res.objectChanges);
          if (!id) throw new Error("no tunnelId");
          tunnelId = id;
          setDigests((d) => ({ ...d, create: res.digest }));
          mp.announceTunnel(m.matchId, tunnelId);
          channel.sendPeer({ t: "opened", tunnelId });
        } else {
          setPhase("opening");
          tunnelId = await new Promise<string>((resolve) => {
            openedResolveRef.current = resolve;
          });
        }

        const obj = await client.getObject({
          id: tunnelId,
          options: { showContent: true },
        });
        const fields = (
          obj.data?.content as { fields?: Record<string, unknown> } | undefined
        )?.fields;
        createdAtRef.current = BigInt(
          (fields?.created_at as string | undefined) ?? 0,
        );

        setPhase("funding");
        // MTPS: deposit this seat's buy-in from a faucet-minted MTPS coin, sponsored (the
        // faucet itself needs the sponsor, so no sender-pays fallback). SUI: sponsored stake with a
        // sender-pays fallback (ADR-0009).
        // ADR-0013: withdraw this seat's buy-in from the wallet's address balance (top up first).
        // Retry (rebuild) through checkpoint-settlement lag instead of erroring out.
        if (isMtpsConfigured && isMtpsAddressBalance)
          await sponsored.ensureStakeBalance(myStake);
        const dep = !isMtpsConfigured
          ? await withSponsorFallback(
              async () =>
                submitSponsored(
                  buildDepositTx(tunnelId, myStake, {
                    stakeCoinId: await sponsored.selectStakeCoin(myStake),
                  }),
                ),
              () => submit(buildDepositTx(tunnelId, myStake)),
              "blackjack pvp deposit",
            )
          : isMtpsAddressBalance
            ? await submitRebuildingOnStale(
                () =>
                  buildDepositTx(tunnelId, myStake, {
                    coinType,
                    stakeFromBalance: {
                      amount: myStake,
                      coinType: MTPS_COIN_TYPE,
                    },
                  }),
                submitSponsored,
                "blackjack pvp deposit",
              )
            : await submitSponsored(
                buildDepositTx(tunnelId, myStake, {
                  coinType,
                  stakeCoinId: await sponsored.prepareStake(myStake),
                }),
              );
        setDigests((d) => ({ ...d, deposit: dep.digest }));
        let activated = false;
        for (let i = 0; i < 40; i++) {
          const o = await client.getObject({
            id: tunnelId,
            options: { showContent: true },
          });
          const f = (
            o.data?.content as { fields?: Record<string, unknown> } | undefined
          )?.fields;
          if (
            Number(f?.status ?? 0) >= 1 &&
            BigInt((f?.party_a_deposit as string) ?? 0) > 0n &&
            BigInt((f?.party_b_deposit as string) ?? 0) > 0n
          ) {
            activated = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (!activated)
          throw new Error(
            "tunnel did not activate (opponent may not have funded)",
          );

        const backend = core.defaultBackend();
        const t = new core.DistributedTunnel<BlackjackState, BlackjackMove>(
          proto,
          {
            tunnelId,
            self: core.makeEndpoint(
              backend,
              walletAddress,
              {
                publicKey: myEph.coreKey.publicKey,
                scheme: 0,
                secretKey: myEph.coreKey.secretKey,
              },
              true,
            ),
            opponent: core.makeEndpoint(
              backend,
              m.opponentWallet,
              { publicKey: oppEphPubkey, scheme: 0 },
              false,
            ),
            selfParty: m.role, // A = player, B = dealer
            moveCodec: blackjackMoveCodec,
          },
          channel.transport,
          { a: stakeA, b: stakeB },
        );
        tunnelRef.current = t;
        transcriptRef.current = new proof.Transcript(tunnelId);

        activateSession(mp, channel, t, {
          matchId: m.matchId,
          role: m.role,
          opponentWallet: m.opponentWallet,
          opponentPubkeyHex: oppHello,
          selfEphemeralSecretHex: bytesToHex(myEph.coreKey.secretKey),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [
      client,
      proto,
      submit,
      submitSponsored,
      sponsored,
      walletAddress,
      finishSettle,
      activateSession,
    ],
  );
  onMatchRef.current = onMatch;

  // Arena entry (ADR-0028): join a pre-allocated match whose tunnel the fleet already created + funded
  // seat B for. This seat is always A (the player); seat A was deposited by the batched `enterArena`
  // PTB, so there is NO create/deposit/stake-exchange here — only the relay + engine wiring over the
  // live tunnel. The bot (seat B = dealer, and the rotated player on alternate rounds) drives its own
  // moves via BlackjackV2Strategy. No "ready" wait: the bot enters its loop the instant its tunnel
  // opens and the relay buffers our first frame. `eph` is the SAME per-game key baked at allocate.
  const enterArenaMatch = useCallback(
    (allocation: ArenaAllocation, eph: KeyPair) => {
      if (!walletAddress) {
        setError("Connect a wallet on the menu first");
        setPhase("error");
        return;
      }
      setError(null);
      setPhase("connecting");
      settledRef.current = false;
      stoppingRef.current = false;
      setRounds([]);
      autoKickedRef.current = false;
      autoRef.current = defaultAuto("blackjack");
      setAutoState(autoRef.current);
      bufferedSettleRef.current = null;
      bufferedHelloRef.current = null;
      openedResolveRef.current = null;
      settleResolveRef.current = null;
      helloResolveRef.current = null;
      void (async () => {
        try {
          const connEph = core.generateKeyPair();
          const mp = new MpClient(
            resolveMpWsUrl(MP_URL),
            walletAddress,
            connEph,
          );
          mpRef.current = mp;
          installResumePersistence();
          await mp.connect();
          // Join the ONE pre-allocated match (role A); the fleet bound the bot as seat B at allocate.
          const m = await mp.joinMatch(allocation.matchId);
          matchIdRef.current = m.matchId;
          roleRef.current = m.role;
          setRole(m.role);
          const channel = mp.channel(m.matchId);
          channelRef.current = channel;
          channel.onPeer((mm: Exclude<PeerMessage, { t: "frame" }>) => {
            if (mm.t === "hello") {
              const pub = String(mm.ephemeralPubkey);
              if (helloResolveRef.current) helloResolveRef.current(pub);
              else bufferedHelloRef.current = pub;
            } else if (mm.t === "settleHalf") {
              const sig = hexToBytes(String(mm.sig));
              const rt = hexToBytes(String(mm.transcriptRoot));
              if (settleResolveRef.current)
                settleResolveRef.current({ sig, root: rt });
              else bufferedSettleRef.current = { sig, root: rt };
            } else if (mm.t === "closed")
              setDigests((d) => ({ ...d, close: String(mm.digest) }));
            else if (mm.t === "stop") {
              stoppingRef.current = true;
              if (tunnelRef.current)
                void finishSettle(tunnelRef.current, channel, m.matchId);
            }
          });

          // The per-game ephemeral key baked into the tunnel at allocate co-signs every move — using a
          // different key would reject every signature. hello carries it; the bot's was baked as B.
          channel.sendPeer({
            t: "hello",
            ephemeralPubkey: bytesToHex(eph.publicKey),
          });
          const oppHello =
            bufferedHelloRef.current ??
            (await new Promise<string>((res) => {
              helloResolveRef.current = res;
            }));
          const oppEphPubkey = hexToBytes(oppHello);

          // No create/deposit: the fleet pre-created the tunnel + funded seat B, and seat A was funded
          // by the batched `enterArena` PTB. Both seats stake the fixed arena buy-in (allocation).
          const stake = BigInt(allocation.stakeEach);
          const obj = await client.getObject({
            id: allocation.tunnelId,
            options: { showContent: true },
          });
          const fields = (
            obj.data?.content as
              | { fields?: Record<string, unknown> }
              | undefined
          )?.fields;
          createdAtRef.current = BigInt(
            (fields?.created_at as string | undefined) ?? 0,
          );

          const backend = core.defaultBackend();
          const t = new core.DistributedTunnel<BlackjackState, BlackjackMove>(
            proto,
            {
              tunnelId: allocation.tunnelId,
              self: core.makeEndpoint(
                backend,
                walletAddress,
                {
                  publicKey: eph.publicKey,
                  scheme: 0,
                  secretKey: eph.secretKey,
                },
                true,
              ),
              opponent: core.makeEndpoint(
                backend,
                m.opponentWallet,
                { publicKey: oppEphPubkey, scheme: 0 },
                false,
              ),
              selfParty: m.role, // A = player
              moveCodec: blackjackMoveCodec,
            },
            channel.transport,
            { a: stake, b: stake },
          );
          tunnelRef.current = t;
          transcriptRef.current = new proof.Transcript(allocation.tunnelId);

          activateSession(mp, channel, t, {
            matchId: m.matchId,
            role: m.role,
            opponentWallet: m.opponentWallet,
            opponentPubkeyHex: oppHello,
            selfEphemeralSecretHex: bytesToHex(eph.secretKey),
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      })();
    },
    [walletAddress, proto, client, activateSession, finishSettle],
  );

  // Centralized batched entry (ADR-0028): the on-connect orchestrator deposited blackjack's seat A in
  // the one batched PTB and published {allocation, keypair} to the arena store. Consume it once and
  // auto-enter — the window comes alive without a "Find match" click. Only from idle (never clobbers a
  // live/resumed match); `clearArenaEntry` consumes it so a remount can't re-enter a closed match.
  const arenaEnteredRef = useRef(false);
  useEffect(() => {
    const tryEnter = () =>
      consumeArenaEntry(
        BLACKJACK_ARENA_GAME_ID,
        arenaEnteredRef,
        () => phase === "idle",
        enterArenaMatch,
      );
    tryEnter();
    return subscribeArena(tryEnter);
  }, [enterArenaMatch, phase]);

  // Player Hit/Stand (only the player, only on the player's turn).
  const proposePlayer = useCallback((action: "hit" | "stand") => {
    const t = tunnelRef.current;
    if (!t) return;
    if (
      roleRef.current !== getPlayerParty(t.state.round) ||
      t.state.phase !== "player"
    )
      return;
    try {
      t.propose({ kind: action }, BigInt(Date.now()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const hit = useCallback(() => proposePlayer("hit"), [proposePlayer]);
  const stand = useCallback(() => proposePlayer("stand"), [proposePlayer]);

  // Place the bet for the next round (player only; the bet deals the round). round_over, not terminal.
  const bet = useCallback(
    (amount: number) => {
      const t = tunnelRef.current;
      if (!t) return;
      if (
        roleRef.current !== getPlayerParty(t.state.round + 1n) ||
        t.state.phase !== "round_over" ||
        proto.isTerminal(t.state)
      )
        return;
      lastBetRef.current = amount; // remember it so auto reuses this stake next round
      try {
        t.propose(bjBetMove(amount, t.state), BigInt(Date.now()));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [proto],
  );

  // Stop & settle the tunnel from a round boundary (either seat). Co-signed; the dealer closes.
  const stop = useCallback(() => {
    const t = tunnelRef.current;
    const channel = channelRef.current;
    if (!t || !channel) return;
    if (t.state.phase !== "round_over") return; // settle cleanly between rounds
    stoppingRef.current = true;
    channel.sendPeer({ t: "stop" });
    void finishSettle(t, channel, matchIdRef.current);
  }, [finishSettle]);

  const setAuto = useCallback(
    (on: boolean) => {
      autoRef.current = on;
      setAutoState(on);
      rememberAuto("blackjack", on);
      const t = tunnelRef.current;
      if (!on || !t || stoppingRef.current || proto.isTerminal(t.state)) return;
      // Resume auto from the current state.
      const st = t.state;
      const owed = actorFor(st, getPlayerParty);
      if (!owed || owed !== roleRef.current) return;
      if (st.phase === "draw_commit" || st.phase === "draw_reveal") {
        const mv = proto.randomMove(st, roleRef.current, Math.random);
        if (mv)
          setTimeout(() => {
            try {
              t.propose(mv, BigInt(Date.now()));
            } catch {
              /* ignore */
            }
          }, 50);
      } else if (st.phase === "player") {
        const mv = proto.randomMove(st, roleRef.current, Math.random);
        if (mv)
          setTimeout(
            () => {
              try {
                t.propose(mv, BigInt(Date.now()));
              } catch {
                /* ignore */
              }
            },
            autoRef.current ? AUTO_MOVE_MS : BOT_MOVE_MS,
          );
      } else if (st.phase === "round_over") {
        const mv = bjBetMove(lastBetRef.current ?? Number(MIN_BET), st);
        setTimeout(
          () => {
            try {
              t.propose(mv, BigInt(Date.now()));
            } catch {
              /* ignore */
            }
          },
          autoRef.current ? AUTO_MOVE_MS : NEXT_MS,
        );
      }
    },
    [proto],
  );

  // If Auto is enabled when the match becomes playable, kick the resume once (the move loop
  // otherwise only schedules auto AFTER a confirmed move, so the first move needs this). Covers a
  // player who ticks Auto on before play; Auto is OFF by default on a fresh load.
  useEffect(() => {
    if (autoKickedRef.current) return;
    if (phase === "playing" && tunnelRef.current && autoRef.current) {
      autoKickedRef.current = true;
      setAuto(true);
    }
  }, [phase, setAuto]);

  // Auto-settle the moment the table goes terminal — a side can't cover the minimum bet (out of
  // chips) or the round cap is hit. The inline onAdvance check handles the common path; this
  // declarative net also covers cases where it was skipped (a stop already in flight, or the
  // terminal state arriving via a resume rather than a fresh confirmed move). settledRef makes
  // the call idempotent, so it never double-settles.
  useEffect(() => {
    if (phase !== "playing" || stoppingRef.current || settledRef.current)
      return;
    const t = tunnelRef.current;
    const ch = channelRef.current;
    if (!t || !ch || !proto.isTerminal(t.state)) return;
    void finishSettle(t, ch, matchIdRef.current);
  }, [phase, state, proto, finishSettle]);

  const leave = useCallback(() => {
    // Back: publish our settlement half before abandoning, so leaving SETTLES (the staying seat / 1h
    // grace path submits the close) instead of stranding the staked tunnel. Sync + best-effort, so the
    // half is on the wire before the transport closes; no live/unsettled match ⇒ just abandon.
    const lt = tunnelRef.current;
    const lch = channelRef.current;
    if (lt && lch && !settledRef.current) {
      try {
        const root = transcriptRef.current
          ? transcriptRef.current.root()
          : new Uint8Array(32);
        const half = lt.buildSettlementHalfWithRoot(
          createdAtRef.current,
          root,
          0n,
        );
        lch.sendPeer({
          t: "settleHalf",
          partyABalance: half.settlement.partyABalance.toString(),
          partyBBalance: half.settlement.partyBBalance.toString(),
          finalNonce: half.settlement.finalNonce.toString(),
          timestamp: half.settlement.timestamp.toString(),
          transcriptRoot: bytesToHex(root),
          sig: bytesToHex(half.sigSelf),
        });
      } catch (e) {
        console.error("[blackjack pvp] leave publish failed:", e);
      }
    }
    detachResumeRef.current?.();
    detachResumeRef.current = null;
    // Explicit leave = abandon this match: drop its resume record so it can't hijack the next
    // PvP entry (resumeActiveTunnels would otherwise restore this now-peerless tunnel and skip
    // matchmaking). Reconnect-after-reload never calls leave, so legitimate resume still works.
    const tid = tunnelRef.current?.tunnelId;
    if (tid) clearResumeRecord(tid);
    mpRef.current?.close();
    mpRef.current = null;
    channelRef.current = null;
    tunnelRef.current = null;
    setPhase("idle");
    setState(null);
    setRole(null);
    setDigests({});
    setRounds([]);
    settledRef.current = false;
    stoppingRef.current = false;
    autoKickedRef.current = false;
    autoRef.current = defaultAuto("blackjack");
    setAutoState(autoRef.current);
    openedResolveRef.current = null;
    settleResolveRef.current = null;
    bufferedSettleRef.current = null;
    stakeResolveRef.current = null;
    bufferedStakeRef.current = null;
    helloResolveRef.current = null;
    bufferedHelloRef.current = null;
  }, []);

  // Find a new match after a settle, reusing the SAME socket (the relay runs many matches per
  // connection): release the settled match and re-quickMatch in place — keeping Auto on so the
  // next match auto-plays (the chosen buy-in in stakeRef carries over). Falls back to a full
  // queue() if the socket is gone.
  const requeue = useCallback(() => {
    const mp = mpRef.current;
    if (!mp) {
      queue();
      return;
    }
    detachResumeRef.current?.();
    detachResumeRef.current = null;
    const tid = tunnelRef.current?.tunnelId;
    if (tid) clearResumeRecord(tid); // closed tunnel: never restore it
    if (matchIdRef.current) mp.releaseMatch(matchIdRef.current);
    channelRef.current = null;
    tunnelRef.current = null;
    setState(null);
    setRole(null);
    setDigests({});
    setRounds([]);
    settledRef.current = false;
    stoppingRef.current = false;
    autoKickedRef.current = false;
    openedResolveRef.current = null;
    settleResolveRef.current = null;
    bufferedSettleRef.current = null;
    stakeResolveRef.current = null;
    bufferedStakeRef.current = null;
    helloResolveRef.current = null;
    bufferedHelloRef.current = null;
    setError(null);
    // Keep Auto + the open socket; just join the queue again.
    setPhase("queuing");
    void (async () => {
      try {
        const m = await mp.quickMatch("blackjack");
        await onMatchRef.current?.(mp, m);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [queue]);

  // After a match settles ("done"), auto-find the next match when Auto is on. A short pause lets
  // the result show before re-queuing.
  useEffect(() => {
    if (phase !== "done" || !autoRef.current) return;
    const id = setTimeout(() => {
      if (autoRef.current) requeue();
    }, AUTO_REQUEUE_MS);
    return () => clearTimeout(id);
  }, [phase, requeue]);

  useEffect(
    () => () => {
      detachResumeRef.current?.();
      mpRef.current?.close();
    },
    [],
  );

  const s = state;
  const isDealer = s
    ? roleRef.current ===
      getDealerParty(s.phase === "round_over" ? s.round + 1n : s.round)
    : roleRef.current === "B";
  const gamePhase = s ? s.phase : null;
  const playerHand = s ? s.playerHand : [];
  // Hide the dealer's hole card during the player's turn (revealed once the dealer acts / round ends).
  const dealerHand = s
    ? s.phase === "player"
      ? s.dealerHand.slice(0, 1)
      : s.dealerHand
    : [];
  const terminal = s ? proto.isTerminal(s) : false;
  const myTurn =
    !!s && s.phase === "player" && roleRef.current === getPlayerParty(s.round);
  const inRoundOver = !!s && s.phase === "round_over";
  // Which side (if any) can no longer cover even the minimum bet — this forces the auto-settle.
  const outOfChips: "player" | "dealer" | null = s
    ? s.balanceA < MIN_BET
      ? "player"
      : s.balanceB < MIN_BET
        ? "dealer"
        : null
    : null;
  // Bet controls: the table max is the poorer side's balance; offer chip buttons that fit.
  const tableMax = s ? tableMaxBet(s) : 0n;
  const betOptions = BET_OPTIONS.filter((v) => BigInt(v) <= tableMax);
  const currentBet = s ? s.bet : 0n;

  return {
    phase,
    error,
    role,
    isDealer,
    playerHand,
    dealerHand,
    playerSum: bjCardsHandValue(playerHand),
    dealerSum:
      s && s.phase !== "player"
        ? bjCardsHandValue(s.dealerHand)
        : bjCardsHandValue(dealerHand),
    balancePlayer: s
      ? getPlayerParty(s.round || 1n) === "A"
        ? s.balanceA
        : s.balanceB
      : 0n,
    balanceDealer: s
      ? getDealerParty(s.round || 1n) === "A"
        ? s.balanceA
        : s.balanceB
      : 0n,
    myBalance: s ? (roleRef.current === "A" ? s.balanceA : s.balanceB) : 0n,
    oppBalance: s ? (roleRef.current === "A" ? s.balanceB : s.balanceA) : 0n,
    round: s ? Number(s.round) : 0,
    gamePhase,
    myTurn,
    inRoundOver,
    terminal,
    outOfChips,
    currentBet,
    tableMax,
    betOptions,
    rounds,
    auto,
    stake,
    fundOptions: [...FUND_OPTIONS],
    walletAddress,
    walletBalance,
    digests,
    fund,
    setStake,
    queue,
    hit,
    stand,
    bet,
    stop,
    setAuto,
    leave,
  };
}
