/**
 * Variable-bet, dealerless player-vs-dealer Blackjack (v2). Party A = player (bets +
 * hit/stand), party B = dealer (deterministic draw-to-17); roles swap every two rounds.
 *
 * v2 closes the "predictable deck" hole of v1 (which derived every card from a public
 * `blake2b256(DOMAIN || round)` stream, so either seat could precompute the whole shoe).
 * EVERY card is now produced by an independent two-party commit-reveal drawn on demand: both
 * seats commit a fresh secret, both reveal, and the rank is derived from BOTH reveals via
 * `core.combineReveals` + rejection sampling. No seat can predict an undrawn card or bias a
 * drawn one, and the derivation is deterministic so a disputer can replay it. A seat that
 * stalls a pending draw is forfeited (`forfeit`), so withholding a reveal to dodge a bad card
 * is never profitable. Secrets are LOCAL ONLY — never encoded into the signed state, and the
 * relay move codec (`bjMoveCodec`) drops them so the opponent only ever sees the commitment.
 *
 * The player still chooses the bet at the start of each round (clamped to the loser's balance),
 * so balances always sum to the locked total. Deck: infinite uniform rank (1..13) with
 * replacement — duplicate ranks are a legal pair.
 */
import { handValue } from "@/games/blackjack/app/lib/bjCards";
import { core, protocols } from "sui-tunnel-ts";

type Party = protocols.Party;
type Balances = protocols.Balances;
type ProtocolContext = protocols.ProtocolContext;

/** Maps a round to the seat that holds the PLAYER role that round. */
export type PlayerPartyFor = (round: bigint) => Party;

// Default rotation: swap the player seat every two rounds. PvP needs this so BOTH humans get
// turns playing (and betting) rather than one being a perpetual dealer. Self-play vs the bot
// pins the player to seat A instead (FIXED_PLAYER_A) — there is no second human to be fair to,
// and a stable seat keeps the player's chips/outcome from inverting as the role would swap.
export function getPlayerParty(round: bigint): Party {
  const r = Number(round) - 1;
  return Math.floor(r / 2) % 2 === 0 ? "A" : "B";
}
export function getDealerParty(round: bigint): Party {
  return getPlayerParty(round) === "A" ? "B" : "A";
}

/** Non-rotating assignment: seat A is always the player, seat B always the dealer. */
export const FIXED_PLAYER_A: PlayerPartyFor = () => "A";

export const MIN_BET = 25n;
/** Chip denominations offered as bet buttons (filtered to <= the table max each round). */
export const BET_OPTIONS = [25, 100, 500, 1000] as const;
/**
 * Per-round bet ceiling, and the on-chain force-close `penalty_amount` the tunnel is opened with.
 * The two MUST match: a seat that stalls a pending draw to dodge a losing round forfeits exactly
 * `penalty_amount` on the dispute/force-close path, so capping the round's stake at this value
 * makes stalling never profitable (you can never have more on the line than you'd forfeit). It
 * also bounds what an offline party can lose to a single round's risk rather than their whole
 * stake. Callers that open the tunnel pass this as the penalty (see bjPvpOnchain / bjTunnel).
 */
export const MAX_BET = 1000n;
const DEALER_STANDS_AT = 17;
const BUST_AT = 21;
const ROUND_CAP = 1000n;

/** A locally-held commit-reveal share: a random value and its hiding salt. */
export interface BetBlackjackSecret {
  value: Uint8Array;
  salt: Uint8Array;
}
export type BetBlackjackReveal = BetBlackjackSecret;

export type BetPhase = "round_over" | "draw_commit" | "draw_reveal" | "player";

export type DrawReason = "deal" | "hit" | "dealer_auto";
export interface DrawContext {
  forHand: "player" | "dealer";
  reason: DrawReason;
}

export interface BetBlackjackState {
  phase: BetPhase;
  round: bigint;
  /** Cards drawn so far this round (also the per-card draw counter). */
  drawCount: bigint;
  playerHand: number[];
  dealerHand: number[];
  /** The in-flight card being drawn, or null between draws. */
  draw: DrawContext | null;
  pendingCommitA: Uint8Array | null;
  pendingCommitB: Uint8Array | null;
  pendingRevealA: BetBlackjackReveal | null;
  pendingRevealB: BetBlackjackReveal | null;
  /** Local-only seat secrets. NEVER encoded into signed state; the relay codec omits them. */
  localSecretA: BetBlackjackSecret | null;
  localSecretB: BetBlackjackSecret | null;
  balanceA: bigint; // player
  balanceB: bigint; // dealer
  total: bigint;
  bet: bigint; // the current round's bet
}

export type BetBlackjackMove =
  | { action: "bet"; amount: number }
  | {
      action: "commit";
      commitment: Uint8Array;
      localSecret?: BetBlackjackSecret;
    }
  | { action: "reveal"; reveal: BetBlackjackReveal }
  | { action: "hit" }
  | { action: "stand" }
  | { action: "forfeit" };

const DOMAIN = protocols.protocolDomain("blackjack.bet.v2");
const PHASE_CODE: Record<BetPhase, number> = {
  round_over: 0,
  player: 1,
  draw_commit: 2,
  draw_reveal: 3,
};
const FORHAND_CODE: Record<DrawContext["forHand"], number> = {
  player: 0,
  dealer: 1,
};
const REASON_CODE: Record<DrawReason, number> = {
  deal: 0,
  hit: 1,
  dealer_auto: 2,
};

// ============================================
// COMMIT-REVEAL HELPERS (reuse the SDK primitives — byte-exact with randomness.move)
// ============================================

/** Derive a rank 1..13 from two reveals (rejection-sampled from both shares, unbiased). */
export function deriveRank(
  a: BetBlackjackReveal,
  b: BetBlackjackReveal,
): number {
  const seed = core.seedFromBytes(
    core.combineReveals(a.value, a.salt, b.value, b.salt),
  );
  const [v] = core.nextU64InRange(seed, 0n, 13n);
  return Number(v) + 1;
}

/**
 * Generate a fresh commit-reveal secret from the platform CSPRNG. Uses
 * `crypto.getRandomValues` (browser + modern Node) — NEVER `Math.random` — so the opponent
 * cannot predict or brute-force the share. The salt is the on-chain minimum (16 bytes); the
 * value carries a full 16 bytes of entropy.
 */
export function secureCommitSecret(): BetBlackjackSecret {
  const value = new Uint8Array(16);
  const salt = new Uint8Array(core.MIN_SALT_LEN);
  crypto.getRandomValues(value);
  crypto.getRandomValues(salt);
  return { value, salt };
}

/** Build a `commit` move (carrying the local pre-image) from a secret. */
export function commitMoveFromSecret(s: BetBlackjackSecret): BetBlackjackMove {
  return {
    action: "commit",
    commitment: core.computeCommitment(s.value, s.salt),
    localSecret: { value: s.value.slice(), salt: s.salt.slice() },
  };
}

/** Build a `reveal` move from a secret. */
export function revealMoveFromSecret(s: BetBlackjackSecret): BetBlackjackMove {
  return {
    action: "reveal",
    reveal: { value: s.value.slice(), salt: s.salt.slice() },
  };
}

function rankValue(rank: number): number {
  if (rank === 1) return 11;
  if (rank >= 11) return 10;
  return rank;
}
const isBust = (h: number[]) => handValue(h) > BUST_AT;

/**
 * Largest bet this round: what both sides can cover, capped at MAX_BET. The MAX_BET cap is the
 * anti-stall invariant — the round's stake can never exceed the on-chain force-close penalty, so
 * withholding a reveal to dodge a loss forfeits at least what the round put at risk.
 */
export function maxBet(s: BetBlackjackState): bigint {
  const affordable = s.balanceA < s.balanceB ? s.balanceA : s.balanceB;
  return affordable < MAX_BET ? affordable : MAX_BET;
}

function canStartRound(s: BetBlackjackState): boolean {
  return maxBet(s) >= MIN_BET;
}

/**
 * The party the protocol expects to act next in single-actor phases. In `round_over` the NEXT
 * round's player places the bet, so the actor is `getPlayerParty(round + 1)`. In a draw phase
 * BOTH seats may owe a move, so this returns the player-on-turn for `player` and the upcoming
 * bettor for `round_over`; use `pendingActionFor` to decide a draw contribution per seat.
 */
export function actorFor(
  s: BetBlackjackState,
  playerPartyFor: PlayerPartyFor = getPlayerParty,
): Party {
  if (s.phase === "player") return playerPartyFor(s.round);
  return playerPartyFor(s.round + 1n);
}

/**
 * What seat `me` should do in the current state, or null if it owes nothing right now.
 * Centralizes the per-seat turn logic for the PvP/bot drivers: both seats contribute to
 * every commit and reveal; only the player bets/plays; the dealer's draws are automatic.
 */
export function pendingActionFor(
  s: BetBlackjackState,
  me: Party,
  playerPartyFor: PlayerPartyFor = getPlayerParty,
): "bet" | "commit" | "reveal" | "play" | null {
  switch (s.phase) {
    case "round_over":
      return me === playerPartyFor(s.round + 1n) && canStartRound(s)
        ? "bet"
        : null;
    case "draw_commit": {
      const mine = me === "A" ? s.pendingCommitA : s.pendingCommitB;
      return mine ? null : "commit";
    }
    case "draw_reveal": {
      const mine = me === "A" ? s.pendingRevealA : s.pendingRevealB;
      const secret = me === "A" ? s.localSecretA : s.localSecretB;
      return !mine && secret ? "reveal" : null;
    }
    case "player":
      return me === playerPartyFor(s.round) ? "play" : null;
  }
}

/**
 * A fixed-amount bet move for the betting (`round_over`) phase, clamped to
 * [MIN_BET, maxBet]. Returns null when the table can no longer fund the minimum bet (the
 * game is effectively terminal) or when called outside the betting phase.
 */
export function fixedBetMove(
  amount: number,
  s: BetBlackjackState,
): BetBlackjackMove | null {
  if (s.phase !== "round_over") return null;
  const cap = maxBet(s);
  if (cap < MIN_BET) return null;
  const amt = Math.max(
    Number(MIN_BET),
    Math.min(Math.floor(amount), Number(cap)),
  );
  return { action: "bet", amount: amt };
}

// ============================================
// STATE TRANSITIONS (pure)
// ============================================

/** Begin a fresh draw: clear all pending commit/reveal/secret state, enter draw_commit. */
function beginDraw(s: BetBlackjackState, ctx: DrawContext): BetBlackjackState {
  return {
    ...s,
    phase: "draw_commit",
    draw: ctx,
    pendingCommitA: null,
    pendingCommitB: null,
    pendingRevealA: null,
    pendingRevealB: null,
    localSecretA: null,
    localSecretB: null,
  };
}

/** Start a new round at `bet` and kick off the opening deal (first player card). */
function dealRound(s: BetBlackjackState, bet: bigint): BetBlackjackState {
  const base: BetBlackjackState = {
    ...s,
    round: s.round + 1n,
    drawCount: 0n,
    playerHand: [],
    dealerHand: [],
    bet,
  };
  return beginDraw(base, { forHand: "player", reason: "deal" });
}

/** Settle the round to `winner` (null = push), clearing draw state. */
function settle(s: BetBlackjackState, winner: Party | null): BetBlackjackState {
  let balanceA = s.balanceA;
  let balanceB = s.balanceB;
  if (winner === "A") {
    const amt = s.bet <= balanceB ? s.bet : balanceB;
    balanceA += amt;
    balanceB -= amt;
  } else if (winner === "B") {
    const amt = s.bet <= balanceA ? s.bet : balanceA;
    balanceB += amt;
    balanceA -= amt;
  }
  return {
    ...s,
    phase: "round_over",
    draw: null,
    pendingCommitA: null,
    pendingCommitB: null,
    pendingRevealA: null,
    pendingRevealB: null,
    localSecretA: null,
    localSecretB: null,
    balanceA,
    balanceB,
  };
}

/** Compare hands and settle (dealer bust / higher value / push). */
function resolveShowdown(
  s: BetBlackjackState,
  playerPartyFor: PlayerPartyFor,
): BetBlackjackState {
  const pv = handValue(s.playerHand);
  const dv = handValue(s.dealerHand);
  const playerParty = playerPartyFor(s.round);
  const dealerParty: Party = playerParty === "A" ? "B" : "A";
  let winner: Party | null;
  if (isBust(s.dealerHand)) winner = playerParty;
  else if (pv > dv) winner = playerParty;
  else if (dv > pv) winner = dealerParty;
  else winner = null;
  return settle(s, winner);
}

/** Apply a freshly derived rank to the target hand and run the continuation. */
function afterDraw(
  s: BetBlackjackState,
  rank: number,
  playerPartyFor: PlayerPartyFor,
): BetBlackjackState {
  const ctx = s.draw!;
  const value = rankValue(rank);
  const playerHand =
    ctx.forHand === "player" ? [...s.playerHand, value] : s.playerHand;
  const dealerHand =
    ctx.forHand === "dealer" ? [...s.dealerHand, value] : s.dealerHand;
  const dealerParty: Party = playerPartyFor(s.round) === "A" ? "B" : "A";
  const base: BetBlackjackState = {
    ...s,
    playerHand,
    dealerHand,
    drawCount: s.drawCount + 1n,
    draw: null,
    pendingCommitA: null,
    pendingCommitB: null,
    pendingRevealA: null,
    pendingRevealB: null,
    localSecretA: null,
    localSecretB: null,
  };

  switch (ctx.reason) {
    case "deal": {
      if (playerHand.length < 2)
        return beginDraw(base, { forHand: "player", reason: "deal" });
      // Deal the dealer only its UP-CARD. The hole card is NOT drawn until the player stands (it
      // becomes the first dealer_auto draw), so the player never has the dealer's second card in
      // its co-signed state while deciding hit/stand — closing the see-the-hole-card edge that a
      // modified client would otherwise get from the plaintext dealerHand.
      if (dealerHand.length < 1)
        return beginDraw(base, { forHand: "dealer", reason: "deal" });
      return { ...base, phase: "player" };
    }
    case "hit": {
      if (isBust(playerHand)) return settle(base, dealerParty);
      return { ...base, phase: "player" };
    }
    case "dealer_auto": {
      if (handValue(dealerHand) < DEALER_STANDS_AT)
        return beginDraw(base, { forHand: "dealer", reason: "dealer_auto" });
      return resolveShowdown(base, playerPartyFor);
    }
  }
}

/** Record a party's commitment; advance to draw_reveal once both have committed. */
function applyCommit(
  s: BetBlackjackState,
  move: Extract<BetBlackjackMove, { action: "commit" }>,
  by: Party,
): BetBlackjackState {
  const already = by === "A" ? s.pendingCommitA : s.pendingCommitB;
  if (already) throw new Error(`party ${by} already committed`);
  if (move.commitment.length !== 32)
    throw new Error("commitment must be 32 bytes");
  const commit = move.commitment.slice();
  // Fall back to a secret already on the state when the move carries none. The relay codec strips
  // localSecret, so a re-seated/restored commit (cold-load resume) arrives without it; a secret that
  // restoreSecret put back on the state for this seat must survive applying that stripped commit, or
  // the resumed seat could never reveal. The live propose path always carries localSecret, so this
  // is a no-op there.
  const existing = by === "A" ? s.localSecretA : s.localSecretB;
  const secret: BetBlackjackSecret | null = move.localSecret
    ? {
        value: move.localSecret.value.slice(),
        salt: move.localSecret.salt.slice(),
      }
    : existing;
  const next: BetBlackjackState = {
    ...s,
    pendingCommitA: by === "A" ? commit : s.pendingCommitA,
    pendingCommitB: by === "B" ? commit : s.pendingCommitB,
    localSecretA: by === "A" ? secret : s.localSecretA,
    localSecretB: by === "B" ? secret : s.localSecretB,
  };
  if (next.pendingCommitA && next.pendingCommitB)
    return { ...next, phase: "draw_reveal" };
  return next;
}

/** Verify and record a party's reveal; derive + apply the card once both revealed. */
function applyReveal(
  s: BetBlackjackState,
  move: Extract<BetBlackjackMove, { action: "reveal" }>,
  by: Party,
  playerPartyFor: PlayerPartyFor,
): BetBlackjackState {
  const already = by === "A" ? s.pendingRevealA : s.pendingRevealB;
  if (already) throw new Error(`party ${by} already revealed`);
  const commit = by === "A" ? s.pendingCommitA : s.pendingCommitB;
  if (!commit) throw new Error(`party ${by} has no commitment to reveal`);
  if (!core.verifyCommitment(commit, move.reveal.value, move.reveal.salt))
    throw new Error(`reveal does not match commitment for party ${by}`);
  const reveal: BetBlackjackReveal = {
    value: move.reveal.value.slice(),
    salt: move.reveal.salt.slice(),
  };
  const next: BetBlackjackState = {
    ...s,
    pendingRevealA: by === "A" ? reveal : s.pendingRevealA,
    pendingRevealB: by === "B" ? reveal : s.pendingRevealB,
  };
  if (next.pendingRevealA && next.pendingRevealB) {
    const rank = deriveRank(next.pendingRevealA, next.pendingRevealB);
    return afterDraw(next, rank, playerPartyFor);
  }
  return next;
}

/** `by` claims the round because the opponent failed to advance the pending draw. */
function claimForfeit(s: BetBlackjackState, by: Party): BetBlackjackState {
  const opp: Party = by === "A" ? "B" : "A";
  if (s.phase === "draw_commit") {
    const mine = by === "A" ? s.pendingCommitA : s.pendingCommitB;
    const theirs = opp === "A" ? s.pendingCommitA : s.pendingCommitB;
    if (!mine || theirs)
      throw new Error("forfeit not claimable: opponent does not owe a commit");
  } else if (s.phase === "draw_reveal") {
    const mine = by === "A" ? s.pendingRevealA : s.pendingRevealB;
    const theirs = opp === "A" ? s.pendingRevealA : s.pendingRevealB;
    if (!mine || theirs)
      throw new Error("forfeit not claimable: opponent does not owe a reveal");
  } else {
    throw new Error("forfeit only valid during a pending draw");
  }
  return settle(s, by);
}

export class BlackjackBetProtocol implements protocols.Protocol<
  BetBlackjackState,
  BetBlackjackMove
> {
  readonly name = "blackjack.bet.v2";
  /** `commit` moves carry the pre-image — DistributedTunnel must be given `bjMoveCodec`. */
  readonly movesCarrySecrets = true;

  // How the player role maps to a seat each round. Defaults to the 2-round rotation; self-play
  // passes FIXED_PLAYER_A to keep the player on seat A. Affects who acts/bets and who wins —
  // never the encoded state, so the wire format and Move parity are unchanged.
  private readonly playerPartyFor: PlayerPartyFor;
  constructor(playerPartyFor: PlayerPartyFor = getPlayerParty) {
    this.playerPartyFor = playerPartyFor;
  }
  private dealerPartyFor(round: bigint): Party {
    return this.playerPartyFor(round) === "A" ? "B" : "A";
  }
  /** The seat the protocol expects to act next in single-actor phases. */
  actorFor(s: BetBlackjackState): Party {
    return actorFor(s, this.playerPartyFor);
  }
  /** What seat `me` should do now, or null. */
  pendingActionFor(
    s: BetBlackjackState,
    me: Party,
  ): "bet" | "commit" | "reveal" | "play" | null {
    return pendingActionFor(s, me, this.playerPartyFor);
  }

  initialState(ctx: ProtocolContext): BetBlackjackState {
    return {
      phase: "round_over",
      round: 0n,
      drawCount: 0n,
      playerHand: [],
      dealerHand: [],
      draw: null,
      pendingCommitA: null,
      pendingCommitB: null,
      pendingRevealA: null,
      pendingRevealB: null,
      localSecretA: null,
      localSecretB: null,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
      bet: 0n,
    };
  }

  applyMove(
    s: BetBlackjackState,
    move: BetBlackjackMove,
    by: Party,
  ): BetBlackjackState {
    switch (s.phase) {
      case "round_over": {
        if (move.action !== "bet")
          throw new Error("place a bet to start the round");
        const nextPlayer = this.playerPartyFor(s.round + 1n);
        if (by !== nextPlayer)
          throw new Error(`only the player (${nextPlayer}) sets the bet`);
        if (this.isTerminal(s))
          throw new Error("game over: a side cannot fund another bet");
        const amount = BigInt(Math.floor(move.amount));
        const cap = maxBet(s);
        if (amount < MIN_BET || amount > cap)
          throw new Error(`bet must be ${MIN_BET}..${cap}`);
        return dealRound(s, amount);
      }
      case "draw_commit": {
        if (move.action === "forfeit") return claimForfeit(s, by);
        if (move.action !== "commit")
          throw new Error(
            `expected 'commit' in draw_commit, got '${move.action}'`,
          );
        return applyCommit(s, move, by);
      }
      case "draw_reveal": {
        if (move.action === "forfeit") return claimForfeit(s, by);
        if (move.action !== "reveal")
          throw new Error(
            `expected 'reveal' in draw_reveal, got '${move.action}'`,
          );
        return applyReveal(s, move, by, this.playerPartyFor);
      }
      case "player": {
        const playerParty = this.playerPartyFor(s.round);
        if (by !== playerParty)
          throw new Error(`it is the player's (${playerParty}) turn`);
        if (move.action === "hit")
          return beginDraw(s, { forHand: "player", reason: "hit" });
        if (move.action === "stand") {
          // Dealer already pat (>= 17) draws nothing — settle immediately.
          if (handValue(s.dealerHand) >= DEALER_STANDS_AT)
            return resolveShowdown(s, this.playerPartyFor);
          return beginDraw(s, { forHand: "dealer", reason: "dealer_auto" });
        }
        throw new Error(
          `expected 'hit' or 'stand' in player phase, got '${move.action}'`,
        );
      }
      default:
        throw new Error(`unexpected phase: ${String(s.phase)}`);
    }
  }

  encodeState(s: BetBlackjackState): Uint8Array {
    const parts: Uint8Array[] = [
      DOMAIN,
      core.u64ToBeBytes(s.balanceA),
      core.u64ToBeBytes(s.balanceB),
      core.u64ToBeBytes(s.round),
      core.u64ToBeBytes(s.drawCount),
      new Uint8Array([PHASE_CODE[s.phase]]),
      core.u64ToBeBytes(s.bet),
      core.u64ToBeBytes(BigInt(s.playerHand.length)),
      Uint8Array.from(s.playerHand),
      core.u64ToBeBytes(BigInt(s.dealerHand.length)),
      Uint8Array.from(s.dealerHand),
    ];
    if (s.draw === null) parts.push(new Uint8Array([0xff]));
    else
      parts.push(
        new Uint8Array([
          1,
          FORHAND_CODE[s.draw.forHand],
          REASON_CODE[s.draw.reason],
        ]),
      );
    parts.push(
      protocols.lengthPrefixedConcat([s.pendingCommitA ?? new Uint8Array(0)]),
    );
    parts.push(
      protocols.lengthPrefixedConcat([s.pendingCommitB ?? new Uint8Array(0)]),
    );
    for (const r of [s.pendingRevealA, s.pendingRevealB]) {
      if (r === null) parts.push(new Uint8Array([0]));
      else {
        parts.push(new Uint8Array([1]));
        parts.push(protocols.lengthPrefixedConcat([r.value]));
        parts.push(protocols.lengthPrefixedConcat([r.salt]));
      }
    }
    return core.concatBytes(parts);
  }

  balances(s: BetBlackjackState): Balances {
    return { a: s.balanceA, b: s.balanceB };
  }

  isTerminal(s: BetBlackjackState): boolean {
    return (
      s.round >= ROUND_CAP || (s.phase === "round_over" && maxBet(s) < MIN_BET)
    );
  }

  randomMove(
    s: BetBlackjackState,
    by: Party,
    rng: () => number,
  ): BetBlackjackMove | null {
    if (this.isTerminal(s)) return null;
    switch (this.pendingActionFor(s, by)) {
      case "bet": {
        const cap = Number(maxBet(s));
        return {
          action: "bet",
          amount: Math.max(Number(MIN_BET), Math.min(100, cap)),
        };
      }
      case "commit": {
        const secret = randomSecret(rng);
        return commitMoveFromSecret(secret);
      }
      case "reveal": {
        const secret = by === "A" ? s.localSecretA : s.localSecretB;
        if (!secret) return null;
        return revealMoveFromSecret(secret);
      }
      case "play":
        return {
          action: handValue(s.playerHand) < DEALER_STANDS_AT ? "hit" : "stand",
        };
      default:
        return null;
    }
  }
}

/**
 * NON-cryptographic secret generator for SIMULATIONS / bots only — seeded by a float `rng` so
 * bot self-play is reproducible. Real human play MUST use `secureCommitSecret` (CSPRNG); the
 * relay never carries the pre-image, so a bot using a predictable secret only affects its own
 * (already-non-adversarial) self-play.
 */
function randomSecret(rng: () => number): BetBlackjackSecret {
  const b = () => Math.floor(rng() * 256) & 0xff;
  return {
    value: Uint8Array.from({ length: 16 }, b),
    salt: Uint8Array.from({ length: core.MIN_SALT_LEN }, b),
  };
}
