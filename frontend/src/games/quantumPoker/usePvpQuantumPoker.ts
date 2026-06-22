import { useCallback, useEffect, useRef, useState } from "react";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import {
  expectedQuantumPokerRevealSlots,
  QuantumPokerProtocol,
  QuantumPokerSeatDriver,
  type PokerMove,
  type PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import { pokerMoveCodec } from "sui-tunnel-ts/protocol/quantumPokerCodec";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  MpClient,
  resolveMpWsUrl,
  type PvpChannel,
  type Role,
} from "../../pvp/mpClient";
import {
  getControlPlaneClient,
  resolveBackendUrl,
} from "../../backend/controlPlane";
import {
  closeCooperativeWithRoot,
  depositStake,
  openAndFundSharedTunnel,
  raiseDisputeUnilateral,
  readCreatedAt,
} from "../../onchain/tunnelTx";
import { coSignedToSettleRequest } from "../../backend/settleRequest";
import { attachResume } from "@/pvp/resumeSession";
import { installResumePersistence, evictExpiredRecords } from "@/pvp/resume";
import { makePokerResumeAdapter } from "./pokerResumeAdapter";

/** Locked per seat (MIST, split off the wallet's SUI gas coin — same lane as Tic-Tac-Toe). */
export const STAKE_BALANCE = 10_000n;
/** Hands played per match before the on-chain settle; chips move off-chain in the tunnel
 *  between hands, and the loop ends early (→ "done") if a seat can't cover the next ante. */
export const HAND_CAP = 50n;
/** Pacing for the auto-driven commit/reveal "plumbing" moves so phases (and the showdown) are
 *  readable — cards flip one street at a time instead of flashing to the result instantly. */
const PLUMBING_DELAY_MS = 300;
/** The showdown hole-card reveal is paced 2x slower than the other plumbing reveals so the
 *  climactic reveal lands instead of flashing past. */
const SHOWDOWN_DELAY_MS = PLUMBING_DELAY_MS * 2;
/** The hand-over result holds the longest — a ~5s pause on the win/loss before the next hand is
 *  dealt, so the outcome clearly registers. */
const HAND_OVER_DELAY_MS = 5_000;
/** Matchmaking queue id — both seats must request the same game. */
const GAME_ID = "quantum-poker";
/** Auto check (else fold) if a seat doesn't act within this many seconds. */
const TURN_SECONDS = 10;

export type PvpPokerStatus =
  | "idle"
  | "matching"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

/** Which betting actions are legal for this seat right now (drives button enablement). */
export interface PvpPokerLegal {
  canCheck: boolean;
  canCall: boolean;
  callAmount: bigint;
  canBet: boolean;
  /** Smallest legal `bet` increment (a raise must clear the opponent's street bet). */
  minBet: bigint;
  /** Largest legal increment = this seat's remaining stack this hand. */
  maxBet: bigint;
}

export interface PvpQuantumPoker {
  status: PvpPokerStatus;
  role: Role | null;
  selfParty: Party | null;
  state: PokerState | null;
  /** This seat's two hole cards (local-only; the opponent's stays null until showdown). */
  myHole: number[] | null;
  myTurnToBet: boolean;
  /** Seconds left on this seat's turn timer (null when it isn't our turn to act). */
  secondsLeft: number | null;
  legal: PvpPokerLegal | null;
  opponentWallet: string | null;
  error: string | null;
  findMatch: () => void;
  fold: () => void;
  check: () => void;
  call: () => void;
  bet: (amount: bigint) => void;
  /** True once this seat or the opponent asked to end early; the current hand finishes, then it settles. */
  endRequested: boolean;
  /** End the match cooperatively after the current hand — stop dealing and settle at the current balances. */
  requestSettle: () => void;
  reset: () => void;
}

type PokerTunnel = DistributedTunnel<PokerState, PokerMove>;

/** Crypto-strong [0,1) source for the seat's commit-reveal secrets. */
const secureRng = (): number => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
};

/** Buffer peer messages so a waiter never misses one that arrived early (mirrors TTT). */
function makeInbox(channel: PvpChannel) {
  const buf = new Map<string, unknown>();
  const waiters = new Map<string, (m: unknown) => void>();
  channel.onPeer((m) => {
    const w = waiters.get(m.t);
    if (w) {
      waiters.delete(m.t);
      w(m);
    } else {
      buf.set(m.t, m);
    }
  });
  return <T = unknown>(t: string): Promise<T> =>
    new Promise((res) => {
      const b = buf.get(t);
      if (b) {
        buf.delete(t);
        res(b as T);
      } else {
        waiters.set(t, res as (m: unknown) => void);
      }
    });
}

const BET_PHASES = new Set<PokerState["phase"]>([
  "preflop_bet",
  "flop_bet",
  "turn_bet",
  "river_bet",
]);

/**
 * The seat that must propose the next NON-betting ("plumbing") move, derived purely from
 * the shared co-signed state so both processes agree. `DistributedTunnel` has no concurrency
 * arbitration — it advances one nonce at a time — so commit/reveal phases (where both seats
 * act) are strictly serialized A-then-B. Betting is owned by `state.toAct`; `null` here means
 * either a betting phase (human-driven) or nothing to do.
 */
function plumbingProposer(s: PokerState): Party | null {
  switch (s.phase) {
    case "commit":
      if (!s.commitA) return "A";
      if (!s.commitB) return "B";
      return null;
    case "open_private_holes":
    case "reveal_flop":
    case "reveal_turn":
    case "reveal_river":
    case "showdown":
      if (expectedQuantumPokerRevealSlots(s, "A").length > 0) return "A";
      if (expectedQuantumPokerRevealSlots(s, "B").length > 0) return "B";
      return null;
    case "hand_over":
      return "A"; // A drives next_hand
    default:
      return null;
  }
}

function streetBet(s: PokerState, p: Party): bigint {
  return p === "A" ? s.streetBetA : s.streetBetB;
}
function totalBet(s: PokerState, p: Party): bigint {
  return p === "A" ? s.totalBetA : s.totalBetB;
}
function balance(s: PokerState, p: Party): bigint {
  return p === "A" ? s.balanceA : s.balanceB;
}

function legalFor(s: PokerState, self: Party): PvpPokerLegal {
  const other: Party = self === "A" ? "B" : "A";
  const diff = streetBet(s, other) - streetBet(s, self); // amount needed to match
  // Effective stack — neither seat can wager past the shorter stack (heads-up), so the bigger
  // stack's surplus is unbettable and a short all-in is always callable.
  const effectiveStack =
    balance(s, "A") < balance(s, "B") ? balance(s, "A") : balance(s, "B");
  const available = effectiveStack - totalBet(s, self); // remaining wagerable this hand
  const canCall = diff > 0n && available >= diff;
  // A `bet` increment raises THIS seat's street bet above the opponent's, so it must
  // exceed `diff` (when facing one) and fit in the remaining stack.
  const minBet = (diff > 0n ? diff : 0n) + 1n;
  const canBet = available >= minBet;
  return {
    canCheck: diff === 0n,
    canCall,
    callAmount: diff > 0n ? diff : 0n,
    canBet,
    minBet,
    maxBet: available,
  };
}

export function usePvpQuantumPoker(): PvpQuantumPoker {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const { report } = useTelemetry();
  const moveIdRef = useRef(0);

  const [status, setStatus] = useState<PvpPokerStatus>("idle");
  const [role, setRole] = useState<Role | null>(null);
  const [state, setState] = useState<PokerState | null>(null);
  const [opponentWallet, setOpponentWallet] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [endRequested, setEndRequested] = useState(false);

  const mpRef = useRef<MpClient | null>(null);
  const dtRef = useRef<PokerTunnel | null>(null);
  const driverRef = useRef<QuantumPokerSeatDriver | null>(null);
  const selfPartyRef = useRef<Party | null>(null);
  // Dedupe auto-proposals: at most one scheduled plumbing move per target nonce, so a
  // commit's secrets are generated exactly once (regenerating would orphan the commitment).
  const autoNonceRef = useRef<bigint>(-1n);
  const transcriptRef = useRef<Transcript | null>(null);
  const channelRef = useRef<PvpChannel | null>(null);
  const detachResumeRef = useRef<(() => void) | null>(null);
  // Early-end: once either seat asks to settle, stop dealing new hands and close at the next clean
  // hand boundary. `settlingRef` guards the single close; `settleNowRef` lets the button/peer
  // message trigger the close (which lives in findMatch's closure) when we're already at hand_over.
  const endRef = useRef(false);
  const settlingRef = useRef(false);
  const settleNowRef = useRef<(() => void) | null>(null);

  const sync = useCallback(() => {
    const dt = dtRef.current;
    if (!dt) return;
    const s = dt.displayState;
    setState({ ...s });
  }, []);

  const reset = useCallback(() => {
    detachResumeRef.current?.();
    detachResumeRef.current = null;
    mpRef.current?.close();
    mpRef.current = null;
    dtRef.current = null;
    driverRef.current = null;
    selfPartyRef.current = null;
    autoNonceRef.current = -1n;
    transcriptRef.current = null;
    channelRef.current = null;
    endRef.current = false;
    settlingRef.current = false;
    settleNowRef.current = null;
    setStatus("idle");
    setRole(null);
    setState(null);
    setOpponentWallet(null);
    setError(null);
    setEndRequested(false);
  }, []);

  // Propose this seat's next automatic commit/reveal/next_hand move, if it's our turn.
  // Generated once per nonce, then sent after a short delay so the table is watchable.
  const maybeAutoPropose = useCallback(() => {
    const dt = dtRef.current;
    const driver = driverRef.current;
    const self = selfPartyRef.current;
    if (!dt || !driver || !self) return;
    if (settlingRef.current) return;
    // Ending early: don't deal a new hand — settle at this clean hand boundary instead.
    if (endRef.current && dt.state.phase === "hand_over") return;
    const targetNonce = dt.nonce + 1n;
    if (autoNonceRef.current === targetNonce) return;
    if (plumbingProposer(dt.state) !== self) return;
    const move = driver.chooseMove(dt.state, secureRng); // commit secrets minted here, once
    if (!move) return;
    autoNonceRef.current = targetNonce;
    const delay =
      dt.state.phase === "hand_over"
        ? HAND_OVER_DELAY_MS
        : dt.state.phase === "showdown"
          ? SHOWDOWN_DELAY_MS
          : PLUMBING_DELAY_MS;
    window.setTimeout(() => {
      const live = dtRef.current;
      if (!live || live.nonce + 1n !== targetNonce) return;
      if (settlingRef.current) return;
      try {
        live.propose(move, 0n);
        sync();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }, delay);
  }, [sync]);

  const propose = useCallback(
    (move: PokerMove) => {
      const dt = dtRef.current;
      const self = selfPartyRef.current;
      if (!dt || !self) return;
      if (!BET_PHASES.has(dt.state.phase) || dt.state.toAct !== self) return;
      try {
        dt.propose(move, 0n);
        sync();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sync],
  );

  const fold = useCallback(() => propose({ kind: "fold" }), [propose]);
  const check = useCallback(() => propose({ kind: "check" }), [propose]);
  const call = useCallback(() => propose({ kind: "call" }), [propose]);
  const bet = useCallback(
    (amount: bigint) => propose({ kind: "bet", amount }),
    [propose],
  );

  // End the match early by mutual agreement: stop dealing new hands and settle at the current
  // (between-hands) balances. The current hand finishes first — we never settle mid-pot. Tell the
  // opponent so their client stops + settles too; if we're already parked at hand_over, settle now.
  const requestSettle = useCallback(() => {
    if (endRef.current || settlingRef.current) return;
    endRef.current = true;
    setEndRequested(true);
    channelRef.current?.sendPeer({ t: "endMatch" });
    if (dtRef.current?.state.phase === "hand_over") settleNowRef.current?.();
  }, []);

  const findMatch = useCallback(() => {
    if (!account) {
      setError("connect a wallet first");
      setStatus("error");
      return;
    }
    const wallet = account.address;
    installResumePersistence();
    evictExpiredRecords();
    const signExec = async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    };
    const reads = client as unknown as Parameters<
      typeof openAndFundSharedTunnel
    >[0]["reads"];

    (async () => {
      try {
        setError(null);
        setStatus("matching");
        const ephemeral: KeyPair = generateKeyPair();
        const mp = new MpClient(
          resolveMpWsUrl(resolveBackendUrl()),
          wallet,
          ephemeral,
        );
        mpRef.current = mp;
        await mp.connect();
        const match = await mp.quickMatch(GAME_ID);
        selfPartyRef.current = match.role;
        setRole(match.role);
        setOpponentWallet(match.opponentWallet);

        const channel = mp.channel(match.matchId);
        const waitPeer = makeInbox(channel);
        channelRef.current = channel;
        endRef.current = false;
        settlingRef.current = false;

        // 1) exchange ephemeral pubkeys (the wallet is only the matchmaking label).
        channel.sendPeer({
          t: "hello",
          ephemeralPubkey: toHex(ephemeral.publicKey),
        });
        const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
        const oppPub = fromHex(hello.ephemeralPubkey);

        // 2) fund on-chain: seat A opens + funds its seat in one tx (one popup) and announces;
        //    seat B gated-deposits its own stake. Identical lane to Tic-Tac-Toe.
        setStatus("funding");
        let tunnelId: string;
        if (match.role === "A") {
          tunnelId = await openAndFundSharedTunnel({
            reads,
            signExec,
            partyA: { address: wallet, publicKey: ephemeral.publicKey },
            partyB: { address: match.opponentWallet, publicKey: oppPub },
            amount: STAKE_BALANCE,
          });
          mp.announceTunnel(match.matchId, tunnelId);
          channel.sendPeer({ t: "open", tunnelId });
        } else {
          const open = await waitPeer<{ tunnelId: string }>("open");
          tunnelId = open.tunnelId;
          await depositStake({ signExec, tunnelId, amount: STAKE_BALANCE });
        }

        // 3) build the distributed poker engine over the relay transport.
        const proto = new QuantumPokerProtocol(HAND_CAP);
        const backend = defaultBackend();
        const self = makeEndpoint(backend, wallet, ephemeral, true);
        const opp = makeEndpoint(
          backend,
          match.opponentWallet,
          { publicKey: oppPub, scheme: ephemeral.scheme },
          false,
        );
        const dt: PokerTunnel = new DistributedTunnel(
          proto,
          {
            tunnelId,
            self,
            opponent: opp,
            selfParty: match.role,
            moveCodec: pokerMoveCodec,
          },
          channel.transport,
          { a: STAKE_BALANCE, b: STAKE_BALANCE },
        );
        dtRef.current = dt;
        driverRef.current = new QuantumPokerSeatDriver(match.role);
        autoNonceRef.current = -1n;
        const transcript = new Transcript(tunnelId);
        transcriptRef.current = transcript;

        // Single cooperative close — at match end, or early once a seat asked to settle. Guarded so
        // both seats' triggers (onConfirmed, the button, the peer's endMatch) close exactly once.
        const triggerSettle = () => {
          if (settlingRef.current) return;
          settlingRef.current = true;
          setStatus("settling");
          void settle(
            dt,
            match.role,
            channel,
            waitPeer,
            reads,
            signExec,
            tunnelId,
            transcript,
            getControlPlaneClient(),
          ).then(
            () => setStatus("settled"),
            (e) => {
              setError(e instanceof Error ? e.message : String(e));
              setStatus("error");
            },
          );
        };
        settleNowRef.current = triggerSettle;

        // Opponent hit "Settle": stop dealing on our side too and close at the next clean boundary
        // (or now, if we're already parked at hand_over).
        void waitPeer("endMatch").then(() => {
          endRef.current = true;
          setEndRequested(true);
          if (dt.state.phase === "hand_over") triggerSettle();
        });

        dt.onConfirmed = (u) => {
          transcript.append(u);
          sync();
          report.pushLocalTxn({
            id: moveIdRef.current++,
            game: "quantum-poker",
            time: new Date().toLocaleTimeString("en-GB"),
            bot: "You",
            type: proto.isTerminal(dt.state) ? "Win/Loss" : "Move",
            status: "Success",
            amount: "",
          });
          // Settle at match end (done), or early at this clean hand boundary once a seat asked to end.
          if (
            proto.isTerminal(dt.state) ||
            (endRef.current && dt.state.phase === "hand_over")
          ) {
            triggerSettle();
            return;
          }
          maybeAutoPropose();
        };

        // Resume wiring: persist on confirm + run the resync handshake on reconnect.
        // The slot secrets / hole cards round-trip only through capture/restore, never the wire.
        detachResumeRef.current?.();
        detachResumeRef.current = attachResume({
          mp,
          channel,
          tunnel: dt,
          adapter: makePokerResumeAdapter({
            getSecret: () => {
              const s = dt.state;
              return {
                localSecretsA: s.localSecretsA,
                localSecretsB: s.localSecretsB,
                holeA: s.holeA,
                holeB: s.holeB,
              };
            },
            setSecret: (sec) => {
              const s = dt.state;
              s.localSecretsA = sec.localSecretsA;
              s.localSecretsB = sec.localSecretsB;
              s.holeA = sec.holeA;
              s.holeB = sec.holeB;
            },
            onReconciled: () => sync(),
          }),
          identity: {
            matchId: match.matchId,
            tunnelId,
            role: match.role,
            game: GAME_ID,
            opponentWallet: match.opponentWallet,
            opponentPubkeyHex: toHex(oppPub),
            selfEphemeralSecretHex: toHex(ephemeral.secretKey),
          },
          // Settlement floor: after the 1h grace, settle from the held checkpoint.
          onGraceExpired: (latest) => {
            if (latest)
              void raiseDisputeUnilateral({
                signExec,
                tunnelId,
                update: latest,
                role: match.role,
              });
          },
        });

        // 4) readiness handshake — only AFTER the engine is wired, so seat A's first
        //    commit can never reach seat B before B's frame handler exists.
        sync();
        setStatus("playing");
        if (match.role === "A") await waitPeer("ready");
        else channel.sendPeer({ t: "ready" });
        maybeAutoPropose(); // seat A kicks off the commit; seat B no-ops until its turn
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();
  }, [account, client, signAndExecute, sync, maybeAutoPropose, report]);

  const self = selfPartyRef.current;
  const myHole =
    state && self ? (self === "A" ? state.holeA : state.holeB) : null;
  const myTurnToBet =
    !!state &&
    !!self &&
    status === "playing" &&
    BET_PHASES.has(state.phase) &&
    state.toAct === self;
  const legal = myTurnToBet && state && self ? legalFor(state, self) : null;

  // Per-turn countdown: if this seat doesn't act within TURN_SECONDS, auto check (else fold)
  // so an idle/away player can't stall the hand. Each seat times only its own decision.
  useEffect(() => {
    if (!myTurnToBet) {
      setSecondsLeft(null);
      return;
    }
    let left = TURN_SECONDS;
    setSecondsLeft(left);
    const id = window.setInterval(() => {
      left -= 1;
      if (left > 0) {
        setSecondsLeft(left);
        return;
      }
      window.clearInterval(id);
      setSecondsLeft(null);
      const dt = dtRef.current;
      const me = selfPartyRef.current;
      if (dt && me && BET_PHASES.has(dt.state.phase) && dt.state.toAct === me) {
        const lg = legalFor(dt.state, me);
        try {
          dt.propose(lg.canCheck ? { kind: "check" } : { kind: "fold" }, 0n);
          sync();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [myTurnToBet, state, sync]);

  return {
    status,
    role,
    selfParty: self,
    state,
    myHole,
    myTurnToBet,
    secondsLeft,
    legal,
    opponentWallet,
    error,
    findMatch,
    fold,
    check,
    call,
    bet,
    endRequested,
    requestSettle,
    reset,
  };
}

/** Exchange root-anchored settlement halves over the relay, asserting both seats anchored the
 *  SAME transcript root, then seat A submits the close via the backend /settle (the settler
 *  anchors the root + archives the transcript to Walrus). Both seats must anchor the same root or
 *  close_cooperative_with_root rebuilds different bytes and on-chain verify fails — so the root is
 *  exchanged and asserted equal before either side trusts the combine. Fallback: wallet-submitted
 *  close_cooperative_with_root when the backend is down. Mirrors the Tic-Tac-Toe lane. */
async function settle(
  dt: PokerTunnel,
  role: Role,
  channel: PvpChannel,
  waitPeer: <T>(t: string) => Promise<T>,
  reads: Parameters<typeof readCreatedAt>[0],
  signExec: Parameters<typeof closeCooperativeWithRoot>[0]["signExec"],
  tunnelId: string,
  transcript: Transcript,
  cp: ReturnType<typeof getControlPlaneClient>,
): Promise<void> {
  const createdAt = await readCreatedAt(reads, tunnelId);
  const root = transcript.root();
  const half = dt.buildSettlementHalfWithRoot(createdAt, root, 0n);
  channel.sendPeer({
    t: "settleHalf",
    partyABalance: half.settlement.partyABalance.toString(),
    partyBBalance: half.settlement.partyBBalance.toString(),
    finalNonce: half.settlement.finalNonce.toString(),
    timestamp: half.settlement.timestamp.toString(),
    transcriptRoot: toHex(root),
    sig: toHex(half.sigSelf),
  });
  const other = await waitPeer<{ sig: string; transcriptRoot: string }>(
    "settleHalf",
  );
  if (other.transcriptRoot !== toHex(root)) {
    throw new Error("settlement transcript-root mismatch between parties");
  }
  const co = dt.combineSettlementWithRoot(
    half.settlement,
    half.sigSelf,
    fromHex(other.sig),
  );
  if (role !== "A") return; // single submitter, mirrors the cooperative-close pattern
  try {
    await cp.settle(
      tunnelId,
      coSignedToSettleRequest(co, transcript.toRecord().entries),
    );
  } catch (e) {
    console.error(
      "[quantum-poker] backend settle failed; falling back to wallet close:",
      e,
    );
    await closeCooperativeWithRoot({ signExec, tunnelId, settlement: co });
  }
}
