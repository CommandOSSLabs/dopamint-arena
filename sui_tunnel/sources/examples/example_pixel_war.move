/// Example: Pixel-WAR (territory duel)
///
/// Two painters fight over one shared pixel canvas through a tunnel. Painting is
/// turn-free: either party may paint any unlocked cell at any time, which sets
/// that cell's OWNER to the painter. A cell LOCKS after `overwrite_limit` paints
/// and rejects all further paints (including the owner's). The session is
/// terminal at a placement `cap` OR when the whole board is locked; whoever OWNS
/// more cells wins and takes `stake` from the loser. A draw shifts nothing.
///
/// All of that — canvas, ownership, lock state, winner, and the resulting stake
/// shift — is computed OFF-CHAIN (sui-tunnel-ts `pixel_paint.war.v1`) and
/// compressed into the co-signed `party_a_balance` / `party_b_balance`. The chain
/// verifies 2-of-2 signatures + a monotonic nonce and pays out those balances; it
/// never re-derives territory (re-hashing the ~12 KB canvas on-chain would be
/// wasteful and adds no guarantee the signed balances don't already provide).
/// This mirrors `example_tic_tac_toe` with ONE deliberate divergence: `record_move`
/// passes the already-signed 32-byte `state_hash` straight through instead of
/// recomputing it (the off-chain hash domain is `pixel_paint.war.v1`).
///
/// Flow (3 on-chain txs in the happy path):
///   create_game() -> join_game() -> [instant off-chain paints] ->
///     settle_game()  OR  raise_dispute() -> resolve_dispute() / force_close()
module sui_tunnel::example_pixel_war;

use sui::clock::Clock;
use sui::coin::Coin;
use sui::event;
use sui_tunnel::signature;
use sui_tunnel::tunnel::{Self, Tunnel};

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EInvalidSignature: vector<u8> = b"Signature verification failed.";

#[error]
const EInvalidNonce: vector<u8> = b"The nonce is invalid; it must be strictly increasing.";

#[error]
const ENoActiveDispute: vector<u8> = b"There is no active dispute to act on.";

#[error]
const EBalanceMismatch: vector<u8> = b"The balance does not match the expected amount after the operation.";

// ============================================
// CONSTANTS
// ============================================

const GAME_ACTIVE: u8 = 0;
const GAME_SETTLED: u8 = 1;
const GAME_DISPUTED: u8 = 2;
const GAME_FORCE_CLOSED: u8 = 3;

/// Winner codes mirror the off-chain `Winner`: 0 none, 1 A, 2 B, 3 draw.
const OUTCOME_NONE: u8 = 0;
const OUTCOME_PLAYER_A: u8 = 1;
const OUTCOME_PLAYER_B: u8 = 2;
const OUTCOME_DRAW: u8 = 3;

const DEFAULT_TIMEOUT_MS: u64 = 600000; // 10 minutes

/// Informational only. MUST stay in lockstep with the off-chain
/// `protocolDomain("pixel_paint.war.v1")` tag folded into `state_hash`. Never
/// used in an on-chain hash — the chain treats `state_hash` as opaque.
const PROTOCOL_TAG: vector<u8> = b"pixel_paint.war.v1";

const STATE_HASH_LEN: u64 = 32;

// ============================================
// STRUCTS
// ============================================

/// Lightweight on-chain mirror of the terminal-relevant scalars. Deliberately
/// does NOT store the canvas/owner/paints arrays (~12 KB at 64x64): those are
/// already committed to via `state_hash`. We keep only what a UI needs after the
/// fact, plus the opaque hash the parties co-signed.
public struct WarState has copy, drop, store {
    /// The 32-byte blake2b256 the parties co-signed (opaque to the chain).
    state_hash: vector<u8>,
    /// Total paints across both painters (terminal trigger at `cap`).
    placed: u64,
    /// Cells currently owned by each seat — the territory that decides the win.
    owned_a: u64,
    owned_b: u64,
    /// 0 none / 1 A / 2 B / 3 draw. Informational; not enforced on-chain.
    winner: u8,
    /// Monotonic state nonce.
    nonce: u64,
}

/// A pixel-war game wrapping a Tunnel. Both painters stake equal amounts.
public struct PixelWarGame<phantom T> has key, store {
    id: UID,
    tunnel: Tunnel<T>,
    status: u8,
    latest_state: WarState,
    stake_amount: u64,
    /// Canvas geometry + rules — event/UI metadata only, never trusted on-chain.
    width: u64,
    height: u64,
    cap: u64,
    overwrite_limit: u64,
}

// ============================================
// EVENTS
// ============================================

public struct WarCreated has copy, drop {
    player_a: address,
    player_b: address,
    stake_amount: u64,
    width: u64,
    height: u64,
    cap: u64,
    overwrite_limit: u64,
    protocol_tag: vector<u8>,
}

public struct WarSettled has copy, drop {
    outcome: u8,
    owned_a: u64,
    owned_b: u64,
    player_a_payout: u64,
    player_b_payout: u64,
}

// ============================================
// CONSTANT GETTERS
// ============================================

public fun game_active(): u8 { GAME_ACTIVE }

public fun game_settled(): u8 { GAME_SETTLED }

public fun game_disputed(): u8 { GAME_DISPUTED }

public fun game_force_closed(): u8 { GAME_FORCE_CLOSED }

public fun outcome_none(): u8 { OUTCOME_NONE }

public fun outcome_player_a(): u8 { OUTCOME_PLAYER_A }

public fun outcome_player_b(): u8 { OUTCOME_PLAYER_B }

public fun outcome_draw(): u8 { OUTCOME_DRAW }

public fun protocol_tag(): vector<u8> { PROTOCOL_TAG }

// ============================================
// GAME LIFECYCLE: open + fund
// ============================================

/// Player A opens a war and stakes. Player B joins with a matching stake.
public fun create_game<T>(
    player_a_address: address,
    player_a_pk: vector<u8>,
    player_b_address: address,
    player_b_pk: vector<u8>,
    stake: Coin<T>,
    width: u64,
    height: u64,
    cap: u64,
    overwrite_limit: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): PixelWarGame<T> {
    assert!(width > 0 && height > 0, EInvalidParameter);
    assert!(cap > 0, EInvalidParameter);
    assert!(overwrite_limit >= 1, EInvalidParameter);
    let stake_amount = stake.value();

    let mut tun = tunnel::create<T>(
        player_a_address,
        player_a_pk,
        signature::ed25519(),
        player_b_address,
        player_b_pk,
        signature::ed25519(),
        DEFAULT_TIMEOUT_MS,
        0,
        clock,
        ctx,
    );

    tun.deposit_party_a(stake, clock, ctx);

    event::emit(WarCreated {
        player_a: player_a_address,
        player_b: player_b_address,
        stake_amount,
        width,
        height,
        cap,
        overwrite_limit,
        protocol_tag: PROTOCOL_TAG,
    });

    PixelWarGame {
        id: object::new(ctx),
        tunnel: tun,
        status: GAME_ACTIVE,
        latest_state: WarState {
            state_hash: vector[],
            placed: 0,
            owned_a: 0,
            owned_b: 0,
            winner: OUTCOME_NONE,
            nonce: 0,
        },
        stake_amount,
        width,
        height,
        cap,
        overwrite_limit,
    }
}

/// One-shot open + share, for use as a PTB entry point.
#[allow(lint(share_owned))]
public entry fun create_and_share_game<T>(
    player_a_address: address,
    player_a_pk: vector<u8>,
    player_b_address: address,
    player_b_pk: vector<u8>,
    stake: Coin<T>,
    width: u64,
    height: u64,
    cap: u64,
    overwrite_limit: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let game = create_game<T>(
        player_a_address,
        player_a_pk,
        player_b_address,
        player_b_pk,
        stake,
        width,
        height,
        cap,
        overwrite_limit,
        clock,
        ctx,
    );
    transfer::share_object(game);
}

/// Player B joins with a matching stake; both deposits unlock state updates.
public entry fun join_game<T>(
    game: &mut PixelWarGame<T>,
    stake: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(game.status == GAME_ACTIVE, EInvalidState);
    assert!(stake.value() == game.stake_amount, EBalanceMismatch);
    game.tunnel.deposit_party_b(stake, clock, ctx);
}

// ============================================
// MOVE TRACKING (optional on-chain checkpoint)
// ============================================

/// Optional on-chain checkpoint of an off-chain state. Normal play never calls
/// this — paints are pure off-chain signature exchanges. Use it to harden a
/// position before going idle.
///
/// DIVERGENCE FROM tic-tac-toe: the already-signed 32-byte `state_hash` is passed
/// straight through (NOT recomputed). The hash the parties signed is
/// `blake2b256(encodeState(...))` over the full canvas with the
/// `sui_tunnel::proto::pixel_paint.war.v1` domain. Recomputing it on-chain would
/// require shipping + hashing ~12 KB of canvas and re-implementing `encodeState`
/// byte-for-byte. `owned_a/owned_b/winner/placed` are informational mirror
/// scalars and are NOT part of any signed message.
public entry fun record_move<T>(
    game: &mut PixelWarGame<T>,
    state_hash: vector<u8>,
    nonce: u64,
    placed: u64,
    owned_a: u64,
    owned_b: u64,
    winner: u8,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    assert!(game.status == GAME_ACTIVE, EInvalidState);
    assert!(nonce > game.latest_state.nonce, EInvalidNonce);
    assert!(state_hash.length() == STATE_HASH_LEN, EInvalidParameter);
    assert!(winner <= OUTCOME_DRAW, EInvalidParameter);
    // Both signatures present together, or both absent (mirror tic-tac-toe).
    assert!(
        (sig_a.is_empty() && sig_b.is_empty()) || (!sig_a.is_empty() && !sig_b.is_empty()),
        EInvalidSignature,
    );

    game.latest_state =
        WarState {
            state_hash,
            placed,
            owned_a,
            owned_b,
            winner,
            nonce,
        };

    if (!sig_a.is_empty()) {
        // The tunnel verifies BOTH sigs over the canonical state_update message
        // and enforces nonce monotonicity + balance-sum. We never re-judge
        // territory. (Re-borrow state_hash from the stored state to avoid moving.)
        game
            .tunnel
            .update_state(
                game.latest_state.state_hash,
                nonce,
                party_a_balance,
                party_b_balance,
                timestamp,
                sig_a,
                sig_b,
                clock,
            );
    };
}

// ============================================
// SETTLEMENT
// ============================================

/// Cooperative close. Both painters sign the final balance split (which already
/// encodes the territory winner + stake shift). The tunnel verifies 2-of-2 over
/// the SETTLEMENT message and transfers coins directly to each party.
public entry fun settle_game<T>(
    game: &mut PixelWarGame<T>,
    player_a_balance: u64,
    player_b_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(game.status == GAME_ACTIVE, EInvalidState);

    game
        .tunnel
        .close_cooperative_and_transfer(
            player_a_balance,
            player_b_balance,
            sig_a,
            sig_b,
            timestamp,
            clock,
            ctx,
        );

    game.status = GAME_SETTLED;

    // Informational outcome from the last mirrored scalars (NOT re-derived from a
    // canvas). The payout already happened above per the co-signed balances.
    event::emit(WarSettled {
        outcome: game.latest_state.winner,
        owned_a: game.latest_state.owned_a,
        owned_b: game.latest_state.owned_b,
        player_a_payout: player_a_balance,
        player_b_payout: player_b_balance,
    });
}

// ============================================
// DISPUTE / CHALLENGE + TIMEOUT
// ============================================

/// Raise a dispute by submitting the newest state you hold, co-signed by the
/// other party. The tunnel verifies the counterparty signature and stores these
/// balances as the pending settlement.
public entry fun raise_dispute<T>(
    game: &mut PixelWarGame<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    other_party_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(game.status == GAME_ACTIVE, EInvalidState);
    game
        .tunnel
        .raise_dispute(
            state_hash,
            nonce,
            party_a_balance,
            party_b_balance,
            timestamp,
            other_party_sig,
            clock,
            ctx,
        );
    game.status = GAME_DISPUTED;
}

/// Counter a dispute with a STRICTLY NEWER co-signed state (both sigs). This is
/// how an honest party defeats a stale-state grief: present the later state you
/// both signed. Returns the tunnel to ACTIVE so settlement can resume.
public entry fun resolve_dispute<T>(
    game: &mut PixelWarGame<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    assert!(game.status == GAME_DISPUTED, ENoActiveDispute);
    game
        .tunnel
        .resolve_dispute(
            state_hash,
            nonce,
            party_a_balance,
            party_b_balance,
            timestamp,
            sig_a,
            sig_b,
            clock,
        );
    game.status = GAME_ACTIVE;
}

/// Force close after the dispute timeout elapses with no newer counter-state.
/// Only the dispute raiser may call; pays out the disputed state's balances.
public entry fun force_close<T>(game: &mut PixelWarGame<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(game.status == GAME_DISPUTED, ENoActiveDispute);
    game.tunnel.force_close_after_timeout(clock, ctx);
    game.status = GAME_FORCE_CLOSED;
}

// ============================================
// ACCESSORS
// ============================================

public fun game_status<T>(g: &PixelWarGame<T>): u8 { g.status }

public fun game_nonce<T>(g: &PixelWarGame<T>): u64 { g.latest_state.nonce }

public fun game_winner<T>(g: &PixelWarGame<T>): u8 { g.latest_state.winner }

public fun game_owned_a<T>(g: &PixelWarGame<T>): u64 { g.latest_state.owned_a }

public fun game_owned_b<T>(g: &PixelWarGame<T>): u64 { g.latest_state.owned_b }

public fun game_placed<T>(g: &PixelWarGame<T>): u64 { g.latest_state.placed }

public fun game_state_hash<T>(g: &PixelWarGame<T>): &vector<u8> { &g.latest_state.state_hash }

public fun game_stake_amount<T>(g: &PixelWarGame<T>): u64 { g.stake_amount }

public fun game_width<T>(g: &PixelWarGame<T>): u64 { g.width }

public fun game_height<T>(g: &PixelWarGame<T>): u64 { g.height }

public fun game_cap<T>(g: &PixelWarGame<T>): u64 { g.cap }

public fun game_overwrite_limit<T>(g: &PixelWarGame<T>): u64 { g.overwrite_limit }

public fun game_tunnel<T>(g: &PixelWarGame<T>): &Tunnel<T> { &g.tunnel }

public fun game_total_pot<T>(g: &PixelWarGame<T>): u64 {
    tunnel::total_balance(&g.tunnel)
}

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_game_for_testing<T>(game: PixelWarGame<T>) {
    let PixelWarGame { id, tunnel, .. } = game;
    id.delete();
    tunnel.destroy_for_testing();
}

#[test_only]
public fun set_status_for_testing<T>(game: &mut PixelWarGame<T>, status: u8) {
    game.status = status;
}
