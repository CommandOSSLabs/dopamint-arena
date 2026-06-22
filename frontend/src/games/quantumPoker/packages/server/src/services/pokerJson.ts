import { toHex } from "sui-tunnel-ts/core/bytes";
import type {
  Settlement,
  SettlementWithRoot,
  StateUpdate,
} from "sui-tunnel-ts/core/wire";
import type {
  PokerHandResult,
  PokerState,
  SlotReveal,
} from "sui-tunnel-ts/protocol/quantumPoker";
import {
  pokerMoveFromJson,
  pokerMoveToJson,
  type PokerMoveJson,
  type SlotRevealJson,
} from "sui-tunnel-ts/protocol/quantumPokerCodec";
import type {
  CoSignedSettlement,
  CoSignedSettlementWithRoot,
  CoSignedUpdate,
} from "./tunnelTypes";

export { pokerMoveFromJson, pokerMoveToJson };
export type { PokerMoveJson, SlotRevealJson };

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
  transcriptRoot?: string;
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

export function settlementToJson(
  settlement: Settlement | SettlementWithRoot,
): SettlementJson {
  const json: SettlementJson = {
    tunnelId: settlement.tunnelId,
    partyABalance: settlement.partyABalance.toString(),
    partyBBalance: settlement.partyBBalance.toString(),
    finalNonce: settlement.finalNonce.toString(),
    timestamp: settlement.timestamp.toString(),
  };
  if ("transcriptRoot" in settlement) {
    json.transcriptRoot = "0x" + toHex(settlement.transcriptRoot);
  }
  return json;
}

export function coSignedSettlementToJson(
  settlement: CoSignedSettlement | CoSignedSettlementWithRoot,
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
