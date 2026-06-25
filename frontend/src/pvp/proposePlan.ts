/**
 * Decide whether (and after how long) this seat should propose its next move. Kept pure and
 * React/relay-free so the propose-timing rules are unit-testable in isolation.
 *
 * Why a plan and not just a `setTimeout(stepMs)`: `stepMs` is a *bot/idle watchability pace* — it
 * throttles a self-driving seat so a bot-vs-bot match is legible and the relay isn't spammed. A
 * HUMAN's keypress must NOT pay that tax: alternation + the ACK round-trip already rate-limit real
 * play, so a manual input proposes with zero added delay. The hard guards (off-turn, mid-flight
 * proposal, terminal) bind regardless of input — eager input only chooses the delay, never bypasses
 * a guard.
 *
 * Type-only `Role` import: erased at runtime, so a consumer (the test) loads no engine deps.
 */
import type { Role } from "./mpClient";

export interface ProposePlan {
  /** Schedule the propose after this many ms; `null` ⇒ do not propose now. */
  delayMs: number | null;
}

export interface ProposeInputs {
  /** This process's seat. */
  myRole: Role;
  /** Whose turn it is at the current nonce. */
  turnRole: Role;
  /** The protocol state is terminal — the match is over. */
  terminal: boolean;
  /** A proposal is already awaiting its ACK (the tunnel's `displayState` is ahead of `state`). */
  hasPending: boolean;
  /** This seat is bot-driven (auto). */
  auto: boolean;
  /** A manual seat has a real (non-idle) intent queued. */
  hasInput: boolean;
  /** The bot/idle pacing budget (ms). */
  stepMs: number;
}

export function proposePlan(i: ProposeInputs): ProposePlan {
  if (i.terminal || i.turnRole !== i.myRole || i.hasPending) {
    return { delayMs: null };
  }
  // Real human input: send at once. Bot or an idle manual seat: pace by stepMs (keeps a
  // bot-vs-bot match legible, and an idle manual seat still advances the world).
  return { delayMs: !i.auto && i.hasInput ? 0 : i.stepMs };
}
