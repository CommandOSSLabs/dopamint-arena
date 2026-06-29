/**
 * Adapter letting the existing blackjack mini-app (PlayerBot, which consumes `BlackjackBotGame`)
 * drive its bot-vs-bot mode through the shared worker `SoloEngine` when `?engine=worker` is on —
 * without rewriting the UI. The DEFAULT (legacy) path is the bespoke `useBlackjackBot`, untouched.
 * Under the flag, the session runs in the worker; fields the worker doesn't surface (tx digests,
 * per-round/settled-tunnel history, the rounds/bet config, rebalance/fund controls) are
 * stubbed/disabled here — the worker path is the A/B-tested showcase, not the funding UI.
 *
 * Blackjack is hidden-info, so it has no shared MAIN-thread solo engine (createSoloSessionHook is
 * public-state only); the legacy path stays the bespoke hook, and only the WORKER lane is shared.
 *
 * Bound once at module load (rules-of-hooks): one of two hooks, stable per session.
 */
import {
  useBlackjackBot,
  type BlackjackBotGame,
  type BlackjackBotView,
  type BlackjackResult,
} from "./app/hooks/useBlackjackBot";
import { useGameSolo } from "@/engine/react/useGameSolo";
import { engineClient } from "@/engine/engineClient";
import { engineEnabled } from "@/engine/flag";
import type { MatchSnapshot } from "@/engine/engineApi";
import {
  blackjackHandValue,
  MIN_BET,
  ROUND_CAP,
} from "sui-tunnel-ts/protocol/blackjack";
import type { BjView } from "./blackjackSoloCore";

const STAKE = Number(MIN_BET);
/** The engine's default per-seat bank (1 MTPS). Reported as the pre-start balance so the mini-app's
 *  SUI-mode `unfunded` gate (which funds the LEGACY bot wallets — irrelevant to the worker, which
 *  funds its ephemeral seats internally on `findSolo`) sees the seats as funded and auto-starts. */
const WORKER_BANK = 1_000_000_000n;

const EMPTY_VIEW: BlackjackBotView = {
  playerCards: [],
  dealerCards: [],
  playerSum: 0,
  dealerSum: 0,
  playerBalance: 0,
  dealerBalance: 0,
  round: 0,
  phase: "round_over",
};

/** Shared `SessionStatus` → the mini-app's `BotPhase` (settled ≙ done). */
function toBotPhase(s: MatchSnapshot["status"]): BlackjackBotGame["phase"] {
  switch (s) {
    case "funding":
      return "funding";
    case "playing":
      return "playing";
    case "settling":
      return "settling";
    case "settled":
      return "done";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

/** Session winner seat (FIXED_PLAYER_A: A = player) → the player-perspective result. */
function toResult(w: BjView["winner"] | undefined): BlackjackResult | null {
  if (w === "A") return "win";
  if (w === "B") return "lose";
  if (w === "draw") return "push";
  return null;
}

/** Worker path: the funded tunnel + per-round loop run in the worker `SoloEngine`; this hook shapes
 *  its snapshot into the `BlackjackBotGame` the mini-app already renders. */
function useWorkerBlackjackBotGame(windowId: string): BlackjackBotGame {
  const snap = useGameSolo(windowId) as MatchSnapshot<BjView>;
  const v = snap.view;
  const phase = toBotPhase(snap.status);
  const view: BlackjackBotView = v
    ? {
        playerCards: v.playerHand,
        dealerCards: v.dealerHand,
        playerSum: blackjackHandValue(v.playerHand),
        dealerSum: blackjackHandValue(v.dealerHand),
        playerBalance: v.balanceA,
        dealerBalance: v.balanceB,
        round: v.round,
        phase: v.phase,
      }
    : EMPTY_VIEW;
  const setAuto = (on: boolean) => {
    if (on !== snap.auto) engineClient.setAuto(windowId, !snap.auto);
  };
  return {
    view,
    result: toResult(v?.winner ?? (snap.result as BjView["winner"] | undefined)),
    // Worker doesn't surface per-round / settled-tunnel history or tx digests — those panels hide.
    rounds: [],
    tunnels: [],
    phase,
    error: snap.error,
    fundNote: null,
    digests: {},
    // Pre-start (no view yet): report the funded bank so the SUI-mode `unfunded` gate passes and
    // auto-start fires; once playing, the real per-seat balances come from the view.
    balances: {
      a: v ? BigInt(Math.trunc(v.balanceA)) : WORKER_BANK,
      b: v ? BigInt(Math.trunc(v.balanceB)) : WORKER_BANK,
    },
    auto: snap.auto,
    setAuto,
    myTurn: !snap.auto && phase === "playing" && !!v && v.phase === "player",
    hit: () => engineClient.submitInput(windowId, { kind: "hit" }),
    stand: () => engineClient.submitInput(windowId, { kind: "stand" }),
    placeBet: (amount: number) =>
      engineClient.submitInput(windowId, {
        kind: "bet",
        amount: BigInt(Math.trunc(amount)),
      }),
    rebalancing: false,
    // Per-tunnel round count is fixed in the spec on this path; the config controls no-op.
    maxRounds: Number(ROUND_CAP),
    setMaxRounds: () => {},
    bet: Number(MIN_BET),
    setBet: () => {},
    betOptions: [Number(MIN_BET)],
    balancesLoaded: true,
    fund: () => {},
    rebalance: () => {},
    startAuto: () => engineClient.findSolo(windowId, "blackjack", STAKE),
    stopAuto: () => engineClient.reset(windowId),
    paused: false,
    pause: () => engineClient.setPaused(windowId, true),
    resume: () => engineClient.setPaused(windowId, false),
    backToConfig: () => engineClient.reset(windowId),
    newGame: () => engineClient.reset(windowId),
    refresh: async () => null,
    pollBalances: async () => {},
  };
}

/** Default (legacy) path: the bespoke main-thread bot-vs-bot session, untouched. */
function useLegacyBlackjackBotGame(_windowId: string): BlackjackBotGame {
  return useBlackjackBot();
}

/** `?engine=worker` routes blackjack bot-vs-bot through the shared worker `SoloEngine`; default
 *  keeps the bespoke `useBlackjackBot`. Selected once at module load (rules-of-hooks). */
export const useBlackjackBotGame: (windowId: string) => BlackjackBotGame =
  engineEnabled() ? useWorkerBlackjackBotGame : useLegacyBlackjackBotGame;
