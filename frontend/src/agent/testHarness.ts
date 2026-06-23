import type { Party, ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";
import type { GameBot, GameKit, StateHash } from "./gameKit";

export interface HarnessResult<S> {
  finalState: S;
  moves: Array<{ by: Party; move: unknown }>;
  accepted: number;
}

export function driveToTerminal<S, M>(
  kit: GameKit<S, M>,
  botA: GameBot<S, M>,
  botB: GameBot<S, M>,
  ctx: ProtocolContext,
): HarnessResult<S> {
  const moves: Array<{ by: Party; move: M }> = [];
  let accepted = 0;
  let state = kit.protocol.initialState(ctx);
  let lastHashes: Record<Party, StateHash | null> = { A: null, B: null };
  const maxRounds = 10_000;

  for (let round = 0; round < maxRounds; round++) {
    if (kit.protocol.isTerminal(state)) break;

    let progressThisRound = false;
    for (const actor of ["A", "B"] as Party[]) {
      const bot = actor === "A" ? botA : botB;
      const h = kit.stateHash(state);
      if (lastHashes[actor] === h) continue;

      const move = bot.plan(state);
      if (move === null) continue;

      let next: S;
      try {
        next = kit.protocol.applyMove(state, move, actor);
      } catch (err) {
        throw new Error(
          `Rejected move for ${actor} in ${kit.id}: ${JSON.stringify(move)}\n${String(err)}`,
        );
      }

      const nextHash = kit.stateHash(next);
      if (nextHash === h) {
        throw new Error(
          `Move for ${actor} in ${kit.id} produced an identical state hash; possible no-op loop.`,
        );
      }

      bot.confirm(state, move);
      lastHashes[actor] = h;
      lastHashes[otherParty(actor)] = null; // opponent must re-evaluate the new state
      state = next;
      moves.push({ by: actor, move });
      accepted++;
      progressThisRound = true;
    }

    if (!progressThisRound) {
      throw new Error(
        `No progress in ${kit.id} at round ${round}; game is not terminal.`,
      );
    }
  }

  if (!kit.protocol.isTerminal(state)) {
    throw new Error(
      `${kit.id} did not reach a terminal state within ${maxRounds} rounds ` +
        `(accepted ${accepted} moves). Possible infinite loop or non-terminating protocol.`,
    );
  }

  return {
    finalState: state,
    moves: moves as Array<{ by: Party; move: unknown }>,
    accepted,
  };
}

function otherParty(p: Party): Party {
  return p === "A" ? "B" : "A";
}
