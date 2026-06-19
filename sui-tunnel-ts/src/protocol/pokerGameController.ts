/**
 * ===== Dopamint extension (not upstream sui-tunnel) =====
 *
 * Framework-agnostic controller for an AUTO (bot-vs-bot) Quantum Poker game over a tunnel.
 * Encapsulates the orchestration that was inlined in `scripts/pokerBotVsBot.ts`:
 *
 *   open (on-chain create_and_fund) -> OffchainTunnel.selfPlay -> the pump loop
 *   (BET_PHASES ? state.toAct : plumbingProposer; persona.chooseMove; tunnel.step) ->
 *   settle (settler-sponsored close, caller-signed close on failure).
 *
 * It owns NOTHING network/chain/wallet-specific: every external effect (opening the
 * tunnel, settling, the fallback close, stats reporting) is supplied by the caller via
 * {@link PokerGameAdapters}. So the same loop drives the headless Node load driver today
 * and can later back a React hook or a backend bot — each supplies its own adapters.
 *
 * `plumbingProposer` + `BET_PHASES` live here (not duplicated in the script / the hook) so
 * every caller shares one definition of "whose turn drives the next move".
 */

import { core, proof } from "../index";
import type { CoSignedSettlementWithRoot, KeyPair } from "../core";
import type { Party } from "./Protocol";
import {
  expectedQuantumPokerRevealSlots,
  type PokerMove,
  type PokerState,
  QuantumPokerProtocol,
} from "./quantumPoker";
import {
  JULES_PROFILE,
  NARI_PROFILE,
  QuantumPokerPersonaDriver,
  type QuantumPokerBotProfile,
} from "./quantumPokerPersona";

/** The on-chain party identity a tunnel seat is opened/funded for (mirrors `onchain.PartyArgs`). */
export interface PartyEndpointSpec {
  address: string;
  publicKey: Uint8Array;
  signatureType: number;
}

/** Betting streets — the actor is `state.toAct`; every other phase routes via {@link plumbingProposer}. */
export const BET_PHASES: ReadonlySet<PokerState["phase"]> = new Set<
  PokerState["phase"]
>(["preflop_bet", "flop_bet", "turn_bet", "river_bet"]);

/**
 * Whoever drives the next non-betting "plumbing" move (commit / reveal slots / next_hand).
 * Returns `null` when no plumbing move is owed by either seat (e.g. a betting street, or a
 * reveal phase with no outstanding slots), so the caller can fall through.
 */
export function plumbingProposer(s: PokerState): Party | null {
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

/** Injected glue: every chain / network / wallet effect the controller needs, supplied by the caller. */
export interface PokerGameAdapters {
  /** Open + fund both seats on-chain; returns the shared tunnel id and its `created_at` (ms). */
  open(spec: {
    partyA: PartyEndpointSpec;
    partyB: PartyEndpointSpec;
    aAmount: bigint;
    bAmount: bigint;
  }): Promise<{ tunnelId: string; createdAt: bigint }>;
  /**
   * Settler-sponsored cooperative close (the happy path). `transcriptEntries` is the full
   * proof-of-existence record (`Transcript.toRecord().entries`). THROW to trigger {@link close}.
   */
  settle(
    tunnelId: string,
    co: CoSignedSettlementWithRoot,
    transcriptEntries: unknown[]
  ): Promise<void>;
  /** Fallback cooperative close signed/paid by the caller (bot keypair / wallet). */
  close(tunnelId: string, co: CoSignedSettlementWithRoot): Promise<void>;
  /** Optional: register a stats session for this tunnel (control-plane reporting). */
  reportSession?(info: {
    tunnelId: string;
    partyA: string;
    partyB: string;
  }): Promise<void>;
  /** Optional: report a batch of off-chain actions (drives Total Actions / TPS). */
  reportActions?(batch: {
    tunnelId: string;
    nonce: bigint;
    actionsDelta: number;
  }): void;
}

/** One tunnel seat: the off-chain signing keypair plus its on-chain address. */
export interface PokerSeatConfig {
  coreKey: KeyPair;
  address: string;
}

export interface PokerGameConfig {
  /** Hands to play before the protocol terminates. */
  handCap: bigint;
  /** Per-seat locked stake (both seats funded equally), coin's smallest unit. */
  perSeat: bigint;
  seatA: PokerSeatConfig;
  seatB: PokerSeatConfig;
  adapters: PokerGameAdapters;
  /** Persona overrides; default NARI (A) / JULES (B). */
  profileA?: QuantumPokerBotProfile;
  profileB?: QuantumPokerBotProfile;
  /** Move chooser RNG (returns [0,1)); defaults to `Math.random`. */
  rng?: () => number;
  /** Delay between off-chain steps in ms; 0 (default) runs the loop as fast as possible. */
  stepDelayMs?: number;
  /** Flush a `reportActions` batch every N actions (the heartbeat cadence). Default 200. */
  reportEvery?: number;
}

export type PokerGameEvent = "settled" | "error";

export interface PokerGameController {
  /** Current off-chain state, or `null` before {@link start} has opened the tunnel. */
  getState(): PokerState | null;
  /** Observe every new state produced by a step. Returns an unsubscribe function. */
  subscribe(cb: (s: PokerState) => void): () => void;
  /** Listen for terminal lifecycle events. */
  on(event: PokerGameEvent, cb: (payload: unknown) => void): void;
  /** Run the whole game headless: open -> pump loop -> settle. Resolves with the totals. */
  start(): Promise<{ hands: number; actions: number }>;
  /** Request the pump loop to halt at the next step boundary (then settle). */
  stop(): void;
}

const DEFAULT_REPORT_EVERY = 200;
// Matches the script's old guard — a hard ceiling so a protocol bug can't spin forever.
const STEP_GUARD = 5_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build an AUTO Quantum Poker controller. Pure orchestration: the returned controller
 * runs the open -> play -> settle lifecycle entirely through `config.adapters`, so it
 * carries no React / Sui-client / wallet dependency of its own.
 */
export function createPokerAutoGame(
  config: PokerGameConfig
): PokerGameController {
  const rng = config.rng ?? Math.random;
  const stepDelayMs = config.stepDelayMs ?? 0;
  const reportEvery = config.reportEvery ?? DEFAULT_REPORT_EVERY;
  const driverA = new QuantumPokerPersonaDriver(
    "A",
    config.profileA ?? NARI_PROFILE
  );
  const driverB = new QuantumPokerPersonaDriver(
    "B",
    config.profileB ?? JULES_PROFILE
  );

  const stateListeners = new Set<(s: PokerState) => void>();
  const eventListeners: Record<PokerGameEvent, Set<(p: unknown) => void>> = {
    settled: new Set(),
    error: new Set(),
  };

  let currentState: PokerState | null = null;
  let stopped = false;

  const notifyState = (s: PokerState) => {
    currentState = s;
    for (const cb of stateListeners) cb(s);
  };
  const emit = (event: PokerGameEvent, payload: unknown) => {
    for (const cb of eventListeners[event]) cb(payload);
  };

  async function start(): Promise<{ hands: number; actions: number }> {
    try {
      const { adapters, perSeat } = config;
      const partyArgs = (seat: PokerSeatConfig): PartyEndpointSpec => ({
        address: seat.address,
        publicKey: seat.coreKey.publicKey,
        signatureType: core.SignatureScheme.ED25519,
      });

      const { tunnelId, createdAt } = await adapters.open({
        partyA: partyArgs(config.seatA),
        partyB: partyArgs(config.seatB),
        aAmount: perSeat,
        bAmount: perSeat,
      });

      await adapters.reportSession?.({
        tunnelId,
        partyA: config.seatA.address,
        partyB: config.seatB.address,
      });

      const proto = new QuantumPokerProtocol(config.handCap);
      const tunnel = core.OffchainTunnel.selfPlay(
        proto,
        tunnelId,
        config.seatA.coreKey,
        config.seatB.coreKey,
        config.seatA.address,
        config.seatB.address,
        { a: perSeat, b: perSeat }
      );
      const transcript = new proof.Transcript(tunnelId);
      tunnel.onUpdate = (u) => transcript.append(u);

      notifyState(tunnel.state);

      let actions = 0;
      let sinceBatch = 0;
      let guard = 0;
      const flushBatch = (nonce: bigint) => {
        if (sinceBatch <= 0) return;
        adapters.reportActions?.({ tunnelId, nonce, actionsDelta: sinceBatch });
        sinceBatch = 0;
      };

      while (
        !stopped &&
        !proto.isTerminal(tunnel.state) &&
        guard++ < STEP_GUARD
      ) {
        const s = tunnel.state;
        const actor: Party | null = BET_PHASES.has(s.phase)
          ? s.toAct
          : plumbingProposer(s);
        if (!actor) break;
        const move: PokerMove | null = (
          actor === "A" ? driverA : driverB
        ).chooseMove(s, rng);
        if (!move) break;
        const r = tunnel.step(move, actor, {
          mode: "full",
          timestamp: createdAt,
        });
        if (!r.verified) throw new Error(`state ${r.nonce} failed dual-verify`);
        actions++;
        sinceBatch++;
        notifyState(tunnel.state);
        if (sinceBatch >= reportEvery) flushBatch(r.nonce);
        if (stepDelayMs > 0) await sleep(stepDelayMs);
      }
      flushBatch(tunnel.latest?.update.nonce ?? 0n);

      // Settle through the settler-sponsored close (full transcript so the backend archives the
      // verifiable history); fall back to a caller-signed cooperative close if that fails.
      const settlement = tunnel.buildSettlementWithRoot(
        createdAt,
        transcript.root()
      );
      try {
        await adapters.settle(
          tunnelId,
          settlement,
          transcript.toRecord().entries
        );
      } catch {
        await adapters.close(tunnelId, settlement);
      }

      const result = { actions, hands: Number(tunnel.state.handNo) };
      emit("settled", { tunnelId, ...result });
      return result;
    } catch (err) {
      emit("error", err);
      throw err;
    }
  }

  return {
    getState: () => currentState,
    subscribe(cb) {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    on(event, cb) {
      eventListeners[event].add(cb);
    },
    start,
    stop() {
      stopped = true;
    },
  };
}
