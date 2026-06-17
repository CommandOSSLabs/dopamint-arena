import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import type { Settlement, StateUpdate } from "sui-tunnel-ts/core/wire";
import type {
  PokerHandResult,
  PokerMove,
  PokerState,
  SlotReveal,
} from "sui-tunnel-ts/protocol/quantumPoker";
import type { CoSignedSettlement, CoSignedUpdate } from "./tunnelTypes";

export type PokerMoveJson =
  | { kind: "commit_slots"; commitments: string[] }
  | { kind: "reveal_slots"; slots: number[]; reveals: SlotRevealJson[] }
  | { kind: "bet"; amount: string }
  | { kind: "check" }
  | { kind: "call" }
  | { kind: "fold" }
  | { kind: "next_hand" };

export interface SlotRevealJson {
  value: string;
  salt: string;
}

export interface StateUpdateJson {
  tunnelId: string;
  stateHash: string;
  nonce: string;
  timestamp: string;
  partyABalance: string;
  partyBBalance: string;
}

export interface CoSignedUpdateJson {
  update: StateUpdateJson;
  sigA: string;
  sigB: string;
}

export interface SettlementJson {
  tunnelId: string;
  partyABalance: string;
  partyBBalance: string;
  finalNonce: string;
  timestamp: string;
}

export interface CoSignedSettlementJson {
  settlement: SettlementJson;
  sigA: string;
  sigB: string;
}

export interface PokerStateSummaryJson {
  phase: PokerState["phase"];
  handNo: string;
  handCap: string;
  board: number[];
  boardSlots: number[];
  boardCounters: number[];
  totalBetA: string;
  totalBetB: string;
  streetBetA: string;
  streetBetB: string;
  toAct: PokerState["toAct"];
  actedA: boolean;
  actedB: boolean;
  foldedBy: PokerState["foldedBy"];
  shownA: boolean;
  shownB: boolean;
  shownHoleA: number[] | null;
  shownHoleB: number[] | null;
  winner: PokerState["winner"];
  lastResult: PokerHandResultJson | null;
  balanceA: string;
  balanceB: string;
  total: string;
  commitASet: boolean;
  commitBSet: boolean;
  revealedSlotsA: number[];
  revealedSlotsB: number[];
}

export interface PokerHandResultJson {
  winner: PokerHandResult["winner"];
  reason: PokerHandResult["reason"];
  scoreA: number | null;
  scoreB: number | null;
  bestA: number[] | null;
  bestB: number[] | null;
  burnedA: number[];
  burnedB: number[];
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function bytesFromHex(
  value: unknown,
  label: string,
  length?: number,
): Uint8Array {
  const bytes = fromHex(expectString(value, label));
  if (length !== undefined && bytes.length !== length) {
    throw new Error(`${label} must be ${length} bytes`);
  }
  return bytes;
}

function revealFromJson(value: unknown, label: string): SlotReveal {
  const reveal = expectRecord(value, label);
  return {
    value: bytesFromHex(reveal.value, `${label}.value`, 32),
    salt: bytesFromHex(reveal.salt, `${label}.salt`, 16),
  };
}

function revealToJson(reveal: SlotReveal): SlotRevealJson {
  return {
    value: "0x" + toHex(reveal.value),
    salt: "0x" + toHex(reveal.salt),
  };
}

export function pokerMoveFromJson(value: unknown): PokerMove {
  const move = expectRecord(value, "move");
  const kind = expectString(move.kind, "move.kind");
  switch (kind) {
    case "commit_slots":
      return {
        kind,
        commitments: expectArray(move.commitments, "move.commitments").map(
          (commitment, index) =>
            bytesFromHex(commitment, `move.commitments[${index}]`, 32),
        ),
      };
    case "reveal_slots":
      return {
        kind,
        slots: expectArray(move.slots, "move.slots").map((slot, index) =>
          expectNumber(slot, `move.slots[${index}]`),
        ),
        reveals: expectArray(move.reveals, "move.reveals").map(
          (reveal, index) => revealFromJson(reveal, `move.reveals[${index}]`),
        ),
      };
    case "bet":
      return { kind, amount: BigInt(expectString(move.amount, "move.amount")) };
    case "check":
    case "call":
    case "fold":
    case "next_hand":
      return { kind };
    default:
      throw new Error(`unsupported move kind ${kind}`);
  }
}

export function pokerMoveToJson(move: PokerMove): PokerMoveJson {
  switch (move.kind) {
    case "commit_slots":
      return {
        kind: move.kind,
        commitments: move.commitments.map(
          (commitment) => "0x" + toHex(commitment),
        ),
      };
    case "reveal_slots":
      return {
        kind: move.kind,
        slots: move.slots.slice(),
        reveals: move.reveals.map(revealToJson),
      };
    case "bet":
      return { kind: move.kind, amount: move.amount.toString() };
    case "check":
    case "call":
    case "fold":
    case "next_hand":
      return { kind: move.kind };
  }
}

export function stateUpdateToJson(update: StateUpdate): StateUpdateJson {
  return {
    tunnelId: update.tunnelId,
    stateHash: "0x" + toHex(update.stateHash),
    nonce: update.nonce.toString(),
    timestamp: update.timestamp.toString(),
    partyABalance: update.partyABalance.toString(),
    partyBBalance: update.partyBBalance.toString(),
  };
}

export function coSignedUpdateToJson(
  update: CoSignedUpdate,
): CoSignedUpdateJson {
  return {
    update: stateUpdateToJson(update.update),
    sigA: "0x" + toHex(update.sigA),
    sigB: "0x" + toHex(update.sigB),
  };
}

export function settlementToJson(settlement: Settlement): SettlementJson {
  return {
    tunnelId: settlement.tunnelId,
    partyABalance: settlement.partyABalance.toString(),
    partyBBalance: settlement.partyBBalance.toString(),
    finalNonce: settlement.finalNonce.toString(),
    timestamp: settlement.timestamp.toString(),
  };
}

export function coSignedSettlementToJson(
  settlement: CoSignedSettlement,
): CoSignedSettlementJson {
  return {
    settlement: settlementToJson(settlement.settlement),
    sigA: "0x" + toHex(settlement.sigA),
    sigB: "0x" + toHex(settlement.sigB),
  };
}

function revealedSlots(reveals: (SlotReveal | null)[]): number[] {
  const slots: number[] = [];
  for (let i = 0; i < reveals.length; i++) {
    if (reveals[i]) slots.push(i);
  }
  return slots;
}

function handResultToJson(result: PokerHandResult): PokerHandResultJson {
  return {
    winner: result.winner,
    reason: result.reason,
    scoreA: result.scoreA,
    scoreB: result.scoreB,
    bestA: result.bestA ? result.bestA.slice() : null,
    bestB: result.bestB ? result.bestB.slice() : null,
    burnedA: result.burnedA.slice(),
    burnedB: result.burnedB.slice(),
  };
}

export function stateSummaryToJson(state: PokerState): PokerStateSummaryJson {
  return {
    phase: state.phase,
    handNo: state.handNo.toString(),
    handCap: state.handCap.toString(),
    board: state.board.slice(),
    boardSlots: state.boardSlots.slice(),
    boardCounters: state.boardCounters.slice(),
    totalBetA: state.totalBetA.toString(),
    totalBetB: state.totalBetB.toString(),
    streetBetA: state.streetBetA.toString(),
    streetBetB: state.streetBetB.toString(),
    toAct: state.toAct,
    actedA: state.actedA,
    actedB: state.actedB,
    foldedBy: state.foldedBy,
    shownA: state.shownA,
    shownB: state.shownB,
    shownHoleA:
      state.shownA && state.shownHoleA ? state.shownHoleA.slice() : null,
    shownHoleB:
      state.shownB && state.shownHoleB ? state.shownHoleB.slice() : null,
    winner: state.winner,
    lastResult: state.lastResult ? handResultToJson(state.lastResult) : null,
    balanceA: state.balanceA.toString(),
    balanceB: state.balanceB.toString(),
    total: state.total.toString(),
    commitASet: state.commitA !== null,
    commitBSet: state.commitB !== null,
    revealedSlotsA: revealedSlots(state.revealsA),
    revealedSlotsB: revealedSlots(state.revealsB),
  };
}
