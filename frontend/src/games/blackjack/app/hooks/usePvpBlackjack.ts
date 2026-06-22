import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, proof, bytesToHex, hexToBytes } from "sui-tunnel-ts";
import { getControlPlaneClient, type RegisterSessionResult } from "@/backend/controlPlane";
import { settleViaBackend } from "@/backend/settle";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSignPersonalMessage,
} from "@mysten/dapp-kit";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { getSuiClient } from "@/games/blackjack/app/lib/bjBots";
import {
  getOrCreateEphemeral,
  attestationMessage,
  verifyAttestation,
} from "@/games/blackjack/app/lib/bjPvpIdentity";
import {
  buildCreateAndShareTx,
  buildDepositTx,
  buildCloseTx,
  buildCloseWithRootTx,
  parseTunnelId,
} from "@/games/blackjack/app/lib/bjPvpOnchain";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { withSponsorFallback } from "@/onchain/sponsor";
import { DOPAMINT_COIN_TYPE, isDopamintConfigured } from "@/onchain/dopamint";
import { RelayClient } from "@/games/blackjack/app/lib/bjRelay";
import { handValue } from "@/games/blackjack/app/lib/bjCards";
import {
  BlackjackBetProtocol,
  maxBet as tableMaxBet,
  BET_OPTIONS,
  MIN_BET,
  getPlayerParty,
  getDealerParty,
  type BetBlackjackState,
  type BetBlackjackMove,
} from "@/games/blackjack/app/lib/bjBetProtocol";

type BlackjackState = BetBlackjackState;
type BlackjackMove = BetBlackjackMove;

// MP relay base (RelayClient appends /v1/mp). Prefer an explicit VITE_MP_URL; otherwise derive
// from the backend base, and when that's empty (same-origin production build) from the page
// origin. Never hardcode localhost — a deployed https site would try ws://127.0.0.1 and fail.
const MP_URL =
  import.meta.env.VITE_MP_URL ||
  (
    import.meta.env.VITE_BACKEND_URL ||
    (typeof location !== "undefined" ? location.origin : "http://127.0.0.1:8080")
  ).replace(/^http/, "ws");
/** Default buy-in (bankroll) deposited on-chain per seat (MIST). Each player chooses their own
 *  before matchmaking; the bet protocol caps each round at min(both balances). */
const DEFAULT_STAKE = 5000n;
/** Buy-in options offered before "Find match" (MIST units, shown 1:1 as chips). */
const FUND_OPTIONS = [2500, 5000, 10000, 25000] as const;
const BOT_MOVE_MS = 700; // player auto-bot move cadence
const DEALER_MS = 600; // dealer reveal pause before auto-drawing
const NEXT_MS = 900; // pause before auto-dealing the next round
const DEFAULT_BET = 100; // auto's starting bet until the player picks one

// Auto re-bet: reuse the player's last chosen bet, clamped to what both sides can still cover.
// Returns null if the table can no longer fund the minimum bet (the round is terminal).
function autoBetMove(
  lastBet: number,
  s: BetBlackjackState,
): BetBlackjackMove | null {
  if (s.phase !== "round_over") return null;
  const cap = Number(tableMaxBet(s));
  if (cap < Number(MIN_BET)) return null;
  return {
    action: "bet",
    amount: Math.max(Number(MIN_BET), Math.min(lastBet, cap)),
  };
}

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
  gamePhase: "player" | "dealer" | "round_over" | null;
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
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const sponsored = useSponsoredSignExec();
  const proto = useMemo(() => new BlackjackBetProtocol(), []);

  const [phase, setPhase] = useState<PvpPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"A" | "B" | null>(null);
  const [state, setState] = useState<BlackjackState | null>(null);
  const [rounds, setRounds] = useState<RoundResult[]>([]);
  const [auto, setAutoState] = useState(false);
  const [stake, setStakeState] = useState<bigint>(DEFAULT_STAKE);
  const [walletBalance, setWalletBalance] = useState<bigint>(0n);
  const [digests, setDigests] = useState<{
    create?: string;
    deposit?: string;
    close?: string;
  }>({});

  const relayRef = useRef<RelayClient | null>(null);
  const tunnelRef = useRef<core.DistributedTunnel<
    BlackjackState,
    BlackjackMove
  > | null>(null);
  const roleRef = useRef<"A" | "B" | null>(null);
  const autoRef = useRef(false);
  const lastBetRef = useRef<number>(DEFAULT_BET); // remembered bet for auto rounds; set on every player bet
  const stakeRef = useRef<bigint>(DEFAULT_STAKE); // chosen buy-in, read inside onMatch without stale closures
  const createdAtRef = useRef<bigint>(0n);
  const matchIdRef = useRef<string>("");
  const settledRef = useRef(false);
  const stoppingRef = useRef(false);
  const onMatchRef =
    useRef<
      (
        relay: RelayClient,
        m: { matchId: string; role: "A" | "B"; opponentWallet: string },
      ) => Promise<void>
    >(undefined);
  const openedResolveRef = useRef<((id: string) => void) | null>(null);
  const settleResolveRef = useRef<((val: { sig: Uint8Array; root: Uint8Array }) => void) | null>(null);
  const bufferedSettleRef = useRef<{ sig: Uint8Array; root: Uint8Array } | null>(null);
  const stakeResolveRef = useRef<((amount: bigint) => void) | null>(null);
  const bufferedStakeRef = useRef<bigint | null>(null);

  const sessionRef = useRef<RegisterSessionResult | null>(null);
  const moveCountRef = useRef(0);
  const actionsRef = useRef(0);
  const lastHeartbeatRef = useRef(Date.now());
  const transcriptRef = useRef<proof.Transcript | null>(null);

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
      .catch((e) => console.error("[blackjack pvp] heartbeat failed:", e));
  }, []);

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
  // the settler pays gas, the stake stays a DOPAMINT coin. signExec returns only a digest, so we
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
      relay: RelayClient,
      matchId: string,
    ) => {
      if (settledRef.current) return;
      settledRef.current = true;
      setPhase("settling");
      flushHeartbeat(t.tunnelId, true);
      const root = transcriptRef.current ? transcriptRef.current.root() : new Uint8Array(32);
      const half = t.buildSettlementHalfWithRoot(createdAtRef.current, root, 0n);
      relay.sendApp(matchId, {
        t: "settle",
        sig: bytesToHex(half.sigSelf),
        root: bytesToHex(root),
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
      if (roleRef.current === "B") {
        // the dealer (the opener) submits the cooperative close
        const closeDigest = await settleViaBackend({
          tunnelId: t.tunnelId,
          settlement: coSigned as any,
          transcript: transcriptRef.current ? transcriptRef.current.toRecord().entries : [],
          label: "blackjack",
          fallbackClose: async () => {
            // Wallet-close fallback needs the tunnel's coin type (DOPAMINT when configured); the
            // /settle path above already sponsored the close server-side. In DOPAMINT mode the dealer
            // holds 0 SUI (gas is sponsored), so the close must route through the gas sponsor too — a
            // wallet-signed close would throw and strand the staked DOPAMINT.
            const coinType = isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined;
            const res = await (isDopamintConfigured ? submitSponsored : submit)(
              buildCloseWithRootTx(t.tunnelId, coSigned, coinType),
            );
            return res.digest;
          },
        });
        // Record the close + signal the opponent on BOTH paths (backend digest or fallback digest).
        if (closeDigest) {
          setDigests((d) => ({ ...d, close: closeDigest }));
          relay.sendApp(matchId, { t: "closed", digest: closeDigest });
        }
      }
      await refreshBalance();
      setPhase("done");
    },
    [submit, submitSponsored, refreshBalance, flushHeartbeat],
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
      autoRef.current = false;
      setAutoState(false); // a fresh game (incl. rematch) starts in manual mode
      try {
        const connEph = core.generateKeyPair();
        const relay = new RelayClient(
          MP_URL,
          walletAddress,
          core.keyPairFromSecret(connEph.secretKey),
        );
        relayRef.current = relay;
        await relay.ready;
        setPhase("queuing");
        relay.on("error", (m) => {
          setError(`${m.code}: ${m.message}`);
          setPhase("error");
        });
        relay.on("match.found", (m) => {
          void onMatchRef.current?.(relay, m as any);
        });
        relay.queueJoin("blackjack");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [walletAddress]);

  const onMatch = useCallback(
    async (
      relay: RelayClient,
      m: { matchId: string; role: "A" | "B"; opponentWallet: string },
    ) => {
      try {
        matchIdRef.current = m.matchId;
        roleRef.current = m.role;
        setRole(m.role);
        // App-channel dispatcher: opened tunnelId, settle half, closed digest, and stop request.
        relay.onApp(m.matchId, (mm) => {
          if (mm.t === "opened")
            openedResolveRef.current?.(String(mm.tunnelId));
          else if (mm.t === "settle") {
            const sig = hexToBytes(String(mm.sig));
            const rt = hexToBytes(String(mm.root));
            if (settleResolveRef.current) settleResolveRef.current({ sig, root: rt });
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
              void finishSettle(tunnelRef.current, relay, m.matchId);
          }
        });
        // Register the party.hello capture synchronously (before any await).
        let helloResolve!: (h: {
          ephemeralPubkey: string;
          walletSig: string;
        }) => void;
        const oppHelloMsg = new Promise<{
          ephemeralPubkey: string;
          walletSig: string;
        }>((res) => {
          helloResolve = res;
        });
        relay.on("party.hello", (h) => {
          if (h.matchId === m.matchId)
            helloResolve({
              ephemeralPubkey: String(h.ephemeralPubkey),
              walletSig: String(h.walletSig),
            });
        });

        const myEph = await getOrCreateEphemeral(m.matchId);
        const { signature: walletSig } = await signPersonalMessage({
          message: attestationMessage(m.matchId, myEph.pubkeyHex),
        });
        relay.partyHello(m.matchId, myEph.pubkeyHex, walletSig);

        const oppHello = await oppHelloMsg;
        const attestOk = await verifyAttestation(
          m.matchId,
          oppHello.ephemeralPubkey,
          oppHello.walletSig,
          m.opponentWallet,
        );
        if (!attestOk)
          console.warn(
            "[pvp] opponent attestation did not verify; proceeding (lobby identity is self-asserted in v1)",
          );
        const oppEphPubkey = hexToBytes(oppHello.ephemeralPubkey);

        // Exchange chosen buy-ins so both seats agree on the (possibly asymmetric) starting balances.
        const myStake = stakeRef.current;
        relay.sendApp(m.matchId, { t: "stake", amount: Number(myStake) });
        const oppStake =
          bufferedStakeRef.current ??
          (await new Promise<bigint>((res) => {
            stakeResolveRef.current = res;
          }));
        // Party A is always the player, party B the dealer — independent of who deposits which buy-in.
        const stakeA = m.role === "A" ? myStake : oppStake; // player's buy-in
        const stakeB = m.role === "B" ? myStake : oppStake; // dealer's buy-in
        const penalty = stakeA < stakeB ? stakeA : stakeB; // unused on cooperative close; keep ≤ both deposits

        // DOPAMINT path (ADR-0010): open/fund sponsored, staking the faucet token; SUI path keeps a
        // sender-pays fallback. `coinType` also threads into the wallet-close fallback (the backend
        // /settle close is sponsored server-side).
        const coinType = isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined;

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
          // identical sponsored or sender-pays — route it sponsored when DOPAMINT for a 0-SUI dealer.
          const res = isDopamintConfigured
            ? await submitSponsored(
                buildCreateAndShareTx(openA, openB, penalty, coinType),
              )
            : await submit(buildCreateAndShareTx(openA, openB, penalty));
          const id = parseTunnelId(res.objectChanges);
          if (!id) throw new Error("no tunnelId");
          tunnelId = id;
          setDigests((d) => ({ ...d, create: res.digest }));
          relay.tunnelOpened(m.matchId, tunnelId);
          relay.sendApp(m.matchId, { t: "opened", tunnelId });
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
        // DOPAMINT: deposit this seat's buy-in from a faucet-minted DOPAMINT coin, sponsored (the
        // faucet itself needs the sponsor, so no sender-pays fallback). SUI: sponsored stake with a
        // sender-pays fallback (ADR-0009).
        const dep = isDopamintConfigured
          ? await submitSponsored(
              buildDepositTx(tunnelId, myStake, {
                coinType,
                stakeCoinId: await sponsored.prepareStake(myStake),
              }),
            )
          : await withSponsorFallback(
              async () =>
                submitSponsored(
                  buildDepositTx(tunnelId, myStake, {
                    stakeCoinId: await sponsored.selectStakeCoin(myStake),
                  }),
                ),
              () => submit(buildDepositTx(tunnelId, myStake)),
              "blackjack pvp deposit",
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
          },
          relay.transport(m.matchId),
          { a: stakeA, b: stakeB },
        );
        tunnelRef.current = t;
        transcriptRef.current = new proof.Transcript(tunnelId);

        // Register the (real, on-chain) tunnel for stats tracking. Best-effort.
        sessionRef.current = null;
        moveCountRef.current = 0;
        actionsRef.current = 0;
        lastHeartbeatRef.current = Date.now();
        getControlPlaneClient()
          .registerSession({
            userAddress: walletAddress,
            game: "blackjack",
            tunnels: [
              {
                tunnelId,
                partyA: m.role === "A" ? walletAddress : m.opponentWallet,
                partyB: m.role === "B" ? walletAddress : m.opponentWallet,
              },
            ],
          })
          .then((s) => {
            sessionRef.current = s;
          })
          .catch((e) => console.error("[blackjack pvp] registerSession failed:", e));

        // Per-round log: record the player's (party A) result's updates.
        let lastLoggedRound = 0;
        let lastBalanceA = Number(stakeA);
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
              playerSum: handValue(st.playerHand),
              dealerSum: handValue(st.dealerHand),
            };
            setRounds((prev) => [...prev, rr].slice(-30));
            lastLoggedRound = Number(st.round);
            lastBalanceA = balA;
          }
          if (stoppingRef.current) return; // a stop/settle is in progress
          if (proto.isTerminal(st)) {
            void finishSettle(t, relay, m.matchId);
            return;
          }
          if (st.phase === "player" && m.role === getPlayerParty(st.round)) {
            if (autoRef.current) {
              const mv = proto.randomMove(st, m.role, Math.random);
              if (mv)
                setTimeout(() => {
                  try {
                    t.propose(mv, BigInt(Date.now()));
                  } catch {
                    /* not my turn / in flight */
                  }
                }, autoRef.current ? 50 : BOT_MOVE_MS);
            }
          } else if (
            st.phase === "dealer" &&
            m.role === getDealerParty(st.round)
          ) {
            // The dealer is deterministic — always auto-stand (triggers draw-to-17), regardless of the toggle.
            setTimeout(() => {
              try {
                t.propose({ action: "stand" }, BigInt(Date.now()));
              } catch {
                /* in flight */
              }
            }, autoRef.current ? 50 : DEALER_MS);
          } else if (
            st.phase === "round_over" &&
            m.role === getPlayerParty(st.round + 1n) &&
            autoRef.current
          ) {
            // Only the player bets (the bet deals the next round); auto reuses the last bet.
            const mv = autoBetMove(lastBetRef.current, st);
            if (mv)
              setTimeout(() => {
                try {
                  t.propose(mv, BigInt(Date.now()));
                } catch {
                  /* raced / in flight */
                }
              }, autoRef.current ? 100 : NEXT_MS);
          }
        };
        t.onConfirmed = (u) => {
          moveCountRef.current += 1;
          actionsRef.current += 1;
          transcriptRef.current?.append(u);
          onAdvance();
          flushHeartbeat(tunnelId, false);
        };
        setPhase("playing");
        setState({ ...t.state });
        onAdvance(); // kick off (deal already dealt round 1 -> player phase)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [client, proto, submit, submitSponsored, sponsored, signPersonalMessage, walletAddress, finishSettle, flushHeartbeat],
  );
  onMatchRef.current = onMatch;

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
      t.propose({ action }, BigInt(Date.now()));
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
        t.propose({ action: "bet", amount }, BigInt(Date.now()));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [proto],
  );

  // Stop & settle the tunnel from a round boundary (either seat). Co-signed; the dealer closes.
  const stop = useCallback(() => {
    const t = tunnelRef.current;
    const relay = relayRef.current;
    if (!t || !relay) return;
    if (t.state.phase !== "round_over") return; // settle cleanly between rounds
    stoppingRef.current = true;
    relay.sendApp(matchIdRef.current, { t: "stop" });
    void finishSettle(t, relay, matchIdRef.current);
  }, [finishSettle]);

  const setAuto = useCallback(
    (on: boolean) => {
      autoRef.current = on;
      setAutoState(on);
      const t = tunnelRef.current;
      if (!on || !t || stoppingRef.current || proto.isTerminal(t.state)) return;
      // Resume auto from the current state.
      const st = t.state;
      if (
        st.phase === "player" &&
        roleRef.current === getPlayerParty(st.round)
      ) {
        const mv = proto.randomMove(st, roleRef.current, Math.random);
        if (mv)
          setTimeout(() => {
            try {
              t.propose(mv, BigInt(Date.now()));
            } catch {
              /* ignore */
            }
          }, autoRef.current ? 50 : BOT_MOVE_MS);
      } else if (
        st.phase === "round_over" &&
        roleRef.current === getPlayerParty(st.round + 1n)
      ) {
        const mv = autoBetMove(lastBetRef.current, st);
        if (mv)
          setTimeout(() => {
            try {
              t.propose(mv, BigInt(Date.now()));
            } catch {
              /* ignore */
            }
          }, autoRef.current ? 100 : NEXT_MS);
      }
    },
    [proto],
  );

  const leave = useCallback(() => {
    relayRef.current?.close();
    relayRef.current = null;
    tunnelRef.current = null;
    setPhase("idle");
    setState(null);
    setRole(null);
    setDigests({});
    setRounds([]);
    settledRef.current = false;
    stoppingRef.current = false;
    autoRef.current = false;
    setAutoState(false);
    openedResolveRef.current = null;
    settleResolveRef.current = null;
    bufferedSettleRef.current = null;
    stakeResolveRef.current = null;
    bufferedStakeRef.current = null;
    sessionRef.current = null;
    moveCountRef.current = 0;
    actionsRef.current = 0;
  }, []);

  useEffect(() => () => relayRef.current?.close(), []);

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
    playerSum: handValue(playerHand),
    dealerSum:
      s && s.phase !== "player"
        ? handValue(s.dealerHand)
        : handValue(dealerHand),
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
