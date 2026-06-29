/**
 * Battleship as a worker-engine `GameSessionSpec` (HIDDEN-INFO: binary move codec + fleet
 * secret). The controller is the worker-side port of `useBattleshipPvp`'s proposeDue/
 * autopilot driver, the `fire` input, and the secret/placement/last-shot local state. It
 * proves the generic engine handles hidden-info games, not just public-state ones — the
 * secret is built here, stripped from the wire by `battleshipMoveCodec`, and never sent to
 * the UI (only `deriveBattleshipView`'s plain output crosses).
 */
import type {
  GameSessionSpec,
  MatchController,
  MatchIo,
} from "@/engine/engineApi";
import { defineGame } from "@/engine/specs/defineGame";
import {
  BattleshipProtocol,
  battleshipMoveCodec,
  type BattleshipState,
  type BattleshipMove,
} from "./protocol/battleship";
import { type FleetSecret, makeFleetSecret } from "./engine/selfPlay";
import { type Placement, placementsToBoard } from "./engine/fleet";
import { randomSalts } from "./engine/merkle";
import { proposeDue } from "./engine/pvpDriver";
import { pickShot, BOT_CONFIGS, DEFAULT_BOT_DIFFICULTY } from "./engine/bot";
import { deriveBattleshipView, type BattleshipView } from "./view";
import { makeBattleshipResumeAdapter } from "./battleshipResumeAdapter";
import type { ResumeAdapter } from "@/pvp/resumeSession";

const STAKE_BALANCE = 1_000_000_000n; // 1 MTPS locked per seat
const STAKE_SHIFT = 200_000_000n; // 0.2 MTPS moves loser → winner on a decisive result

class BattleshipController
  implements
    MatchController<
      BattleshipState,
      BattleshipMove,
      Placement[],
      number,
      BattleshipView
    >
{
  private secret: FleetSecret | null = null;
  private placements: Placement[] = [];
  private lastYourShot: number | null = null;
  private lastEnemyShot: number | null = null;

  constructor(private readonly io: MatchIo<BattleshipState, BattleshipMove>) {}

  initSetup(placements: Placement[]): void {
    this.placements = placements;
    this.secret = makeFleetSecret(placementsToBoard(placements), randomSalts());
  }

  onConfirmed(): void {
    const dt = this.io.tunnel();
    if (!dt || !this.secret) return;
    const st = dt.state;
    if (st.pendingShot && st.pendingShot.by !== this.io.role) {
      this.lastEnemyShot = st.pendingShot.cell;
    }
    // Drive the ordered commit + defender reveals; only autopilot-fire when nothing was
    // proposed this tick (a shot racing another move corrupts the frame — see useBattleshipPvp).
    const proposed = proposeDue(dt, this.io.role, this.secret);
    if (!proposed) this.autoFireIfDue();
  }

  onInput(cell: number): void {
    this.fire(cell);
  }

  setAuto(on: boolean): void {
    if (on) this.autoFireIfDue();
  }

  deriveView(state: BattleshipState): BattleshipView {
    return deriveBattleshipView(state, this.placements, this.io.role, {
      lastYourShot: this.lastYourShot,
      lastEnemyShot: this.lastEnemyShot,
      onChain: true,
    });
  }

  resumeAdapter(): ResumeAdapter<BattleshipState, BattleshipMove> {
    return makeBattleshipResumeAdapter({
      getSecret: () => this.secret!,
      setSecret: (s) => {
        this.secret = s;
      },
      getPlacements: () => this.placements,
      setPlacements: (p) => {
        this.placements = p;
      },
      onReconciled: () => this.io.emitView(),
    });
  }

  dispose(): void {
    /* event-driven: no timers to clear */
  }

  private autoFireIfDue(): void {
    if (!this.io.auto()) return;
    const dt = this.io.tunnel();
    const role = this.io.role;
    if (!dt) return;
    const st = dt.state;
    if (st.phase !== "playing" || st.pendingShot || st.turn !== role || st.winner !== 0) {
      return;
    }
    const cell = pickShot(st, role, Math.random, BOT_CONFIGS[DEFAULT_BOT_DIFFICULTY]);
    this.fire(cell);
  }

  private fire(cell: number): void {
    const dt = this.io.tunnel();
    const role = this.io.role;
    if (!dt) return;
    const st = dt.state;
    if (st.phase !== "playing" || st.pendingShot || st.turn !== role || st.winner !== 0) {
      return;
    }
    const atOpponent = role === "A" ? st.shotsAtB : st.shotsAtA;
    if (atOpponent.some((s) => s.cell === cell)) return;
    try {
      dt.propose({ type: "shoot", cell }, 0n);
      this.lastYourShot = cell;
      this.io.emitView();
    } catch {
      /* proposal already pending — ignore */
    }
  }
}

export const battleshipSpec: GameSessionSpec<
  BattleshipState,
  BattleshipMove,
  Placement[],
  number,
  BattleshipView
> = defineGame({
  game: "battleship",
  stake: STAKE_BALANCE,
  // event-driven (commit-reveal); no idle pacing, so stepMs is omitted.
  makeProtocol: () => new BattleshipProtocol(STAKE_SHIFT),
  moveCodec: battleshipMoveCodec,
  createMatch: (io) => new BattleshipController(io),
});
