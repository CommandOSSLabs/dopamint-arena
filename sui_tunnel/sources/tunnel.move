/// Module: tunnel
///
/// Core tunnel primitives for the Sui Tunnel Framework.
/// A tunnel is a two-party state channel that enables high-frequency off-chain
/// interactions with on-chain settlement guarantees.
///
/// ## Tunnel Lifecycle
///
/// ```
/// ┌─────────┐     ┌────────┐     ┌────────┐
/// │ Created │ ──► │ Active │ ──► │ Closed │
/// └─────────┘     └────────┘     └────────┘
///      │              │              │
///      │   deposit()  │   close()    │
///      └──────────────┴──────────────┘
/// ```
///
/// ## Key Concepts
///
/// - **Parties**: Two participants (party_a and party_b) who interact through the tunnel
/// - **Deposits**: Each party deposits funds that are locked in the tunnel
/// - **State Commitment**: A hash of the current off-chain state
/// - **Nonce**: Monotonically increasing counter for replay protection
/// - **Settlement**: Final distribution of funds when tunnel closes
///
/// ## Usage Example
///
/// ```move
/// // Party A creates a tunnel
/// let tunnel = tunnel::create<SUI>(
///     party_a_pk, signature::ed25519(),
///     party_b_pk, signature::bls12381_min_sig(),
///     ctx
/// );
///
/// // Both parties deposit funds
/// tunnel::deposit_party_a(&mut tunnel, coin_a);
/// tunnel::deposit_party_b(&mut tunnel, coin_b);
///
/// // ... off-chain interactions ...
///
/// // Close with agreed final state
/// tunnel::close_cooperative(&mut tunnel, final_balance_a, final_balance_b, sig_a, sig_b, clock);
/// ```
///
/// ## Security Model
///
/// - Both parties must agree on state transitions (dual signatures)
/// - Timeout-based dispute resolution protects against unresponsive parties
/// - Nonces prevent replay attacks
/// - Domain separation prevents cross-tunnel signature reuse
module sui_tunnel::tunnel;

use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::dynamic_field as df;
use sui::event;
use sui::hash;
use sui_tunnel::signature;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EAlreadyExists: vector<u8> = b"The resource already exists and cannot be created again.";

#[error]
const ENotFound: vector<u8> = b"The requested resource was not found.";

#[error]
const ENotSupported: vector<u8> = b"The requested operation is not supported.";

#[error]
const EInvalidHash: vector<u8> = b"The hash value is invalid or has the wrong format.";

#[error]
const EInvalidSignature: vector<u8> = b"Signature verification failed.";

#[error]
const EInvalidPublicKey: vector<u8> = b"The public key is invalid or has the wrong length for its scheme.";

#[error]
const EUnsupportedSignatureType: vector<u8> = b"The signature scheme is not supported.";

#[error]
const ETunnelClosed: vector<u8> = b"The tunnel is closed or not in the required state for this operation.";

#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

#[error]
const EInvalidNonce: vector<u8> = b"The nonce is invalid; it must be strictly increasing.";

#[error]
const EInvalidVersion: vector<u8> = b"The object version does not match the current module version.";

#[error]
const EStaleState: vector<u8> = b"The state update was rejected because a newer state already exists.";

#[error]
const EInvalidTranscriptRoot: vector<u8> = b"The transcript root must be exactly 32 bytes.";

#[error]
const ENoActiveDispute: vector<u8> = b"There is no active dispute to act on.";

#[error]
const ETimeoutNotReached: vector<u8> = b"The timeout has not been reached yet.";

#[error]
const ERefereeNotAuthorized: vector<u8> = b"The referee is not authorized to act on this tunnel.";

#[error]
const EInvalidTimeout: vector<u8> = b"The timeout value is invalid.";

#[error]
const EInvalidPreimage: vector<u8> = b"The HTLC preimage is invalid.";

#[error]
const EHtlcExpired: vector<u8> = b"The HTLC has expired.";

#[error]
const EHtlcNotExpired: vector<u8> = b"The HTLC has not expired yet.";

#[error]
const EInsufficientBalance: vector<u8> = b"Insufficient balance for this operation.";

#[error]
const EBalanceSumMismatch: vector<u8> = b"The party balances do not sum to the total tunnel balance.";

#[error]
const EMinimumDepositNotMet: vector<u8> = b"The deposit is below the required minimum.";

// ============================================
// CONSTANTS
// ============================================

/// Current struct version for upgrade compatibility
const CURRENT_VERSION: u64 = 1;

/// Tunnel status: Created but not yet active
const STATUS_CREATED: u8 = 0;

/// Tunnel status: Active and accepting state updates
const STATUS_ACTIVE: u8 = 1;

/// Tunnel status: Closed and settled
const STATUS_CLOSED: u8 = 2;

/// Tunnel status: Disputed (waiting for resolution)
const STATUS_DISPUTED: u8 = 3;

/// Tunnel status: Destroyed (tombstoned, inert)
const STATUS_DESTROYED: u8 = 4;

/// Minimum deposit amount (in base units)
const MIN_DEPOSIT: u64 = 1;

// ============================================
// STRUCTS
// ============================================

/// Configuration for a tunnel party
public struct PartyConfig has copy, drop, store {
    /// The party's address
    address: address,
    /// The party's public key for signature verification
    public_key: vector<u8>,
    /// The signature type used by this party
    signature_type: u8,
}

/// Represents a commitment to off-chain state
public struct StateCommitment has copy, drop, store {
    /// Hash of the current state
    state_hash: vector<u8>,
    /// Monotonically increasing nonce
    nonce: u64,
    /// Timestamp when this commitment was made
    timestamp: u64,
    /// Balance allocated to party A in this state
    party_a_balance: u64,
    /// Balance allocated to party B in this state
    party_b_balance: u64,
}

/// The core Tunnel object - a two-party state channel
public struct Tunnel<phantom T> has key, store {
    id: UID,
    /// Struct version for upgrade compatibility
    version: u64,
    /// Configuration for party A
    party_a: PartyConfig,
    /// Configuration for party B
    party_b: PartyConfig,
    /// Combined deposits from both parties
    balance: Balance<T>,
    /// Amount deposited by party A
    party_a_deposit: u64,
    /// Amount deposited by party B
    party_b_deposit: u64,
    /// Current tunnel status
    status: u8,
    /// Latest committed state
    state: StateCommitment,
    /// Timestamp when tunnel was created
    created_at: u64,
    /// Timestamp of last activity
    last_activity: u64,
    /// Optional timeout duration in milliseconds (0 = no timeout)
    timeout_ms: u64,
    /// Optional penalty amount for uncooperative behavior.
    /// Applied during `force_close_after_timeout`: the dispute raiser receives
    /// this amount from the non-responding party's balance (capped at their balance).
    penalty_amount: u64,
    /// Address of the party who raised the current dispute (if any)
    dispute_raiser: Option<address>,
}

/// Data structure for settlement agreement
/// Both parties sign this to agree on final balances
public struct SettlementData has copy, drop {
    /// The tunnel ID
    tunnel_id: ID,
    /// Final balance for party A
    party_a_balance: u64,
    /// Final balance for party B
    party_b_balance: u64,
    /// Final state nonce
    final_nonce: u64,
    /// Settlement timestamp
    timestamp: u64,
}

/// Settlement that additionally anchors a Merkle root of the full off-chain
/// transcript (proof-of-existence + compressed-transcript settlement, Deliverable 7/8).
/// Both parties sign this; the root commits an arbitrarily long update history to a
/// single 32-byte value settled on-chain.
public struct SettlementWithRootData has copy, drop {
    tunnel_id: ID,
    party_a_balance: u64,
    party_b_balance: u64,
    final_nonce: u64,
    timestamp: u64,
    /// 32-byte Merkle root over the off-chain state-update transcript.
    transcript_root: vector<u8>,
}

/// Data structure for state updates.
/// Both parties sign this to update the off-chain state.
/// Includes balance distribution so that disputes can be settled on-chain
/// using the balances from the latest co-signed state.
public struct StateUpdateData has copy, drop {
    /// The tunnel ID
    tunnel_id: ID,
    /// New state hash
    state_hash: vector<u8>,
    /// New nonce (must be > current nonce)
    nonce: u64,
    /// Update timestamp (agreed off-chain, validated on-chain)
    timestamp: u64,
    /// Balance allocated to party A
    party_a_balance: u64,
    /// Balance allocated to party B
    party_b_balance: u64,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a new tunnel is created
public struct TunnelCreated has copy, drop {
    tunnel_id: ID,
    party_a: address,
    party_b: address,
    created_at: u64,
}

/// Emitted when a party deposits funds
public struct TunnelDeposit has copy, drop {
    tunnel_id: ID,
    party: address,
    amount: u64,
    total_balance: u64,
}

/// Emitted when tunnel becomes active
public struct TunnelActivated has copy, drop {
    tunnel_id: ID,
    party_a_deposit: u64,
    party_b_deposit: u64,
    activated_at: u64,
}

/// Emitted when state is updated on-chain
public struct StateUpdated has copy, drop {
    tunnel_id: ID,
    state_hash: vector<u8>,
    nonce: u64,
    timestamp: u64,
}

/// Emitted when tunnel is closed
public struct TunnelClosed has copy, drop {
    tunnel_id: ID,
    party_a_balance: u64,
    party_b_balance: u64,
    final_nonce: u64,
    closed_at: u64,
}

/// Emitted when a tunnel is cooperatively closed with a transcript-root anchor.
public struct TunnelClosedWithRoot has copy, drop {
    tunnel_id: ID,
    party_a_balance: u64,
    party_b_balance: u64,
    final_nonce: u64,
    transcript_root: vector<u8>,
    closed_at: u64,
}

/// Emitted when a dispute is raised
public struct DisputeRaised has copy, drop {
    tunnel_id: ID,
    raised_by: address,
    state_hash: vector<u8>,
    nonce: u64,
    timestamp: u64,
}

/// Emitted when a dispute is resolved by submitting a newer state
public struct DisputeResolved has copy, drop {
    tunnel_id: ID,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
}

/// Emitted when a party withdraws from a non-active tunnel
public struct TunnelWithdrawal has copy, drop {
    tunnel_id: ID,
    party: address,
    amount: u64,
    timestamp: u64,
}

/// Emitted when a closed tunnel is destroyed (tombstoned)
public struct TunnelDestroyed has copy, drop {
    tunnel_id: ID,
    destroyed_by: address,
    timestamp: u64,
}

/// Emitted when timeout is extended
public struct TunnelTimeoutExtended has copy, drop {
    tunnel_id: ID,
    extended_by: address,
    additional_ms: u64,
    new_timeout_ms: u64,
    timestamp: u64,
}

/// Emitted when an HTLC is locked in a tunnel
public struct HTLCLocked has copy, drop {
    tunnel_id: ID,
    payment_hash: vector<u8>,
    amount: u64,
    sender: address,
    receiver: address,
    expiry_ms: u64,
}

/// Emitted when an HTLC is claimed with a preimage
public struct HTLCClaimedInTunnel has copy, drop {
    tunnel_id: ID,
    payment_hash: vector<u8>,
    amount: u64,
    claimed_by: address,
}

/// Emitted when an HTLC expires and funds return to sender
public struct HTLCExpiredInTunnel has copy, drop {
    tunnel_id: ID,
    payment_hash: vector<u8>,
    amount: u64,
    returned_to: address,
}

/// Emitted when a referee is assigned to a tunnel
public struct RefereeAssigned has copy, drop {
    tunnel_id: ID,
    referee: address,
}

/// Emitted when a referee resolves a dispute
public struct DisputeResolvedByReferee has copy, drop {
    tunnel_id: ID,
    referee: address,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
}

/// Emitted when a package-local verifier resolves a dispute after proof validation
public struct DisputeResolvedByVerifiedProof has copy, drop {
    tunnel_id: ID,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
}

// ============================================
// DYNAMIC FIELD TYPES
// ============================================

/// Key for HTLC stored as a dynamic field on a tunnel
public struct HTLCKey has copy, drop, store { payment_hash: vector<u8> }

/// Key for per-party HTLC counter
public struct HTLCPartyCounterKey has copy, drop, store { party: address }

/// Key for referee configuration
public struct RefereeKey has copy, drop, store {}

/// Per-party counter for HTLC-locked amounts
public struct HTLCPartyCounter has drop, store {
    count: u64,
    total_locked: u64,
}

/// HTLC locked within a tunnel via dynamic field.
/// Holds actual Balance<T> carved from the tunnel's balance, enabling
/// on-chain HTLC enforcement for multi-hop payments.
public struct TunnelHTLC<phantom T> has store {
    /// Hash of the preimage (blake2b256)
    payment_hash: vector<u8>,
    /// Amount locked
    amount: u64,
    /// Tunnel party who locked the HTLC
    sender: address,
    /// Address that can claim with preimage
    receiver: address,
    /// Expiry timestamp (after which sender can reclaim)
    expiry_ms: u64,
    /// Actual locked funds
    balance: Balance<T>,
}

/// Data structure for HTLC lock agreement.
/// The counterparty signs this to authorize the HTLC.
public struct HTLCLockData has copy, drop {
    /// The tunnel ID
    tunnel_id: ID,
    /// Payment hash (blake2b256 of preimage)
    payment_hash: vector<u8>,
    /// Amount to lock
    amount: u64,
    /// Tunnel party locking the HTLC
    sender: address,
    /// Address that can claim with preimage
    receiver: address,
    /// Expiry timestamp
    expiry_ms: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS FOR CONSTANTS
// ============================================

public fun status_created(): u8 { STATUS_CREATED }

public fun status_active(): u8 { STATUS_ACTIVE }

public fun status_closed(): u8 { STATUS_CLOSED }

public fun status_disputed(): u8 { STATUS_DISPUTED }

public fun status_destroyed(): u8 { STATUS_DESTROYED }

// ============================================
// CONSTRUCTOR FUNCTIONS
// ============================================

/// Validates parameters, constructs a fresh `Tunnel<T>`, and emits `TunnelCreated`.
///
/// Single source of truth for the tunnel's initial layout/state and the creation event,
/// shared by every constructor (`create`, `create_and_share`, `create_and_fund`). Keeping
/// the struct literal in one place means a changed default (initial status, nonce, or
/// timestamp semantics) cannot drift silently between constructors.
fun build_tunnel<T>(
    party_a_address: address,
    party_a_pk: vector<u8>,
    party_a_sig_type: u8,
    party_b_address: address,
    party_b_pk: vector<u8>,
    party_b_sig_type: u8,
    timeout_ms: u64,
    penalty_amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Tunnel<T> {
    validate_create_params(
        party_a_address,
        party_b_address,
        party_a_sig_type,
        party_b_sig_type,
        &party_a_pk,
        &party_b_pk,
    );
    // State channels require a timeout for dispute resolution safety.
    // Without a timeout, funds can be permanently trapped if a party becomes unresponsive.
    assert!(timeout_ms > 0, EInvalidTimeout);

    let now = clock.timestamp_ms();
    let tunnel_id = object::new(ctx);
    let id_copy = tunnel_id.to_inner();

    let tunnel = Tunnel<T> {
        id: tunnel_id,
        version: CURRENT_VERSION,
        party_a: PartyConfig {
            address: party_a_address,
            public_key: party_a_pk,
            signature_type: party_a_sig_type,
        },
        party_b: PartyConfig {
            address: party_b_address,
            public_key: party_b_pk,
            signature_type: party_b_sig_type,
        },
        balance: balance::zero<T>(),
        party_a_deposit: 0,
        party_b_deposit: 0,
        status: STATUS_CREATED,
        state: StateCommitment {
            state_hash: vector[],
            nonce: 0,
            timestamp: now,
            party_a_balance: 0,
            party_b_balance: 0,
        },
        created_at: now,
        last_activity: now,
        timeout_ms,
        penalty_amount,
        dispute_raiser: option::none(),
    };

    event::emit(TunnelCreated {
        tunnel_id: id_copy,
        party_a: party_a_address,
        party_b: party_b_address,
        created_at: now,
    });

    tunnel
}

/// Creates a new tunnel between two parties and returns it (the caller decides how to
/// store/share it; see `create_and_share` for the share-in-one-call variant).
///
/// ## Parameters
/// - `party_a_address`: Address of party A
/// - `party_a_pk`: Public key of party A
/// - `party_a_sig_type`: Signature type for party A
/// - `party_b_address`: Address of party B
/// - `party_b_pk`: Public key of party B
/// - `party_b_sig_type`: Signature type for party B
/// - `timeout_ms`: Dispute timeout in milliseconds; must be `> 0` (a tunnel with no
///   timeout could trap funds forever, so `0` is rejected with `EInvalidTimeout`)
/// - `penalty_amount`: Penalty for uncooperative behavior (0 for no penalty)
/// - `clock`: Clock for timestamp
/// - `ctx`: Transaction context
///
/// ## Returns
/// A new Tunnel object (owned by the caller, not yet shared)
public fun create<T>(
    party_a_address: address,
    party_a_pk: vector<u8>,
    party_a_sig_type: u8,
    party_b_address: address,
    party_b_pk: vector<u8>,
    party_b_sig_type: u8,
    timeout_ms: u64,
    penalty_amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Tunnel<T> {
    build_tunnel<T>(
        party_a_address,
        party_a_pk,
        party_a_sig_type,
        party_b_address,
        party_b_pk,
        party_b_sig_type,
        timeout_ms,
        penalty_amount,
        clock,
        ctx,
    )
}

/// Creates a tunnel and shares it immediately.
///
/// `build_tunnel` returns a freshly-constructed object that is shared without escaping this
/// function, so the `share_owned` lint (which flags sharing an object received from elsewhere)
/// is a false positive here and is suppressed.
#[allow(lint(share_owned))]
public fun create_and_share<T>(
    party_a_address: address,
    party_a_pk: vector<u8>,
    party_a_sig_type: u8,
    party_b_address: address,
    party_b_pk: vector<u8>,
    party_b_sig_type: u8,
    timeout_ms: u64,
    penalty_amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let tunnel = build_tunnel<T>(
        party_a_address,
        party_a_pk,
        party_a_sig_type,
        party_b_address,
        party_b_pk,
        party_b_sig_type,
        timeout_ms,
        penalty_amount,
        clock,
        ctx,
    );
    transfer::share_object(tunnel);
}

// ===== Dopamint extension (not upstream sui-tunnel) =====
// Added downstream for the Dopamint arena demo; keep isolated in this banner so
// an upstream re-sync produces an obvious conflict here rather than silent drift.

/// Creates a tunnel and funds BOTH parties from the transaction sender, then shares it.
///
/// Unlike `deposit_party_a`/`deposit_party_b`, this does NOT require the sender to be a
/// party: the funder need not be party A or party B. This exists for the demo's self-play
/// model, where a single user wallet opens and funds multiple 2-party tunnels in one PTB,
/// and the parties are the user's own ephemeral keys that hold no funds. Both stakes are
/// supplied as `Coin<T>` arguments (typically SplitCoins results), so the wallet can fund
/// both sides of all its tunnels under a single signature.
///
/// This is `public fun` (not `entry`) so it composes with PTB command results.
///
/// Funding reuses `deposit_internal` for both sides, so `TunnelDeposit` fires twice and
/// `maybe_activate` emits `TunnelActivated` once both deposits land — the backend indexer
/// relies on those events, so they must fire exactly as in the normal deposit path. Note this
/// emits `TunnelCreated` and `TunnelActivated` in the SAME transaction/checkpoint (the normal
/// flow spreads them across separate txs), so the indexer must handle atomic create+activate.
///
/// Returns the shared tunnel's `ID` so a PTB can chain it.
/// `create_and_fund` is the same operation without the return value.
///
/// `share_owned` is suppressed for the same reason as `create_and_share`: `build_tunnel`
/// returns a freshly-created object that never escapes this function before being shared.
#[allow(lint(share_owned))]
public fun create_and_fund_with_id<T>(
    party_a_address: address,
    party_a_pk: vector<u8>,
    party_a_sig_type: u8,
    party_b_address: address,
    party_b_pk: vector<u8>,
    party_b_sig_type: u8,
    party_a_coin: Coin<T>,
    party_b_coin: Coin<T>,
    timeout_ms: u64,
    penalty_amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    let mut tunnel = build_tunnel<T>(
        party_a_address,
        party_a_pk,
        party_a_sig_type,
        party_b_address,
        party_b_pk,
        party_b_sig_type,
        timeout_ms,
        penalty_amount,
        clock,
        ctx,
    );
    let id_copy = object::id(&tunnel);

    // Fund both sides; the second deposit triggers maybe_activate once both are > 0.
    deposit_internal(&mut tunnel, party_a_coin, true, clock);
    deposit_internal(&mut tunnel, party_b_coin, false, clock);

    transfer::share_object(tunnel);
    id_copy
}

public fun create_and_fund<T>(
    party_a_address: address,
    party_a_pk: vector<u8>,
    party_a_sig_type: u8,
    party_b_address: address,
    party_b_pk: vector<u8>,
    party_b_sig_type: u8,
    party_a_coin: Coin<T>,
    party_b_coin: Coin<T>,
    timeout_ms: u64,
    penalty_amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    create_and_fund_with_id<T>(
        party_a_address,
        party_a_pk,
        party_a_sig_type,
        party_b_address,
        party_b_pk,
        party_b_sig_type,
        party_a_coin,
        party_b_coin,
        timeout_ms,
        penalty_amount,
        clock,
        ctx,
    );
}
// ===== end Dopamint extension =====

/// Validates parameters for tunnel creation
fun validate_create_params(
    party_a_address: address,
    party_b_address: address,
    party_a_sig_type: u8,
    party_b_sig_type: u8,
    party_a_pk: &vector<u8>,
    party_b_pk: &vector<u8>,
) {
    assert!(party_a_address != party_b_address, EInvalidParties);
    assert!(signature::is_valid_signature_type(party_a_sig_type), EUnsupportedSignatureType);
    assert!(signature::is_valid_signature_type(party_b_sig_type), EUnsupportedSignatureType);
    assert!(signature::is_valid_public_key_length(party_a_sig_type, party_a_pk), EInvalidPublicKey);
    assert!(signature::is_valid_public_key_length(party_b_sig_type, party_b_pk), EInvalidPublicKey);
}

// ============================================
// DEPOSIT FUNCTIONS
// ============================================

/// Deposit funds - auto-detects party from sender
public fun deposit<T>(tunnel: &mut Tunnel<T>, coin: Coin<T>, clock: &Clock, ctx: &TxContext) {
    let sender = ctx.sender();
    let is_party_a = if (sender == tunnel.party_a.address) {
        true
    } else if (sender == tunnel.party_b.address) {
        false
    } else {
        abort ENotAuthorized
    };
    deposit_internal(tunnel, coin, is_party_a, clock);
}

/// Deposit funds as party A
public fun deposit_party_a<T>(
    tunnel: &mut Tunnel<T>,
    coin: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == tunnel.party_a.address, ENotAuthorized);
    deposit_internal(tunnel, coin, true, clock);
}

/// Deposit funds as party B
public fun deposit_party_b<T>(
    tunnel: &mut Tunnel<T>,
    coin: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == tunnel.party_b.address, ENotAuthorized);
    deposit_internal(tunnel, coin, false, clock);
}

/// Internal deposit logic shared by all deposit functions
fun deposit_internal<T>(tunnel: &mut Tunnel<T>, coin: Coin<T>, is_party_a: bool, clock: &Clock) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    // Only allow deposits before activation. Once active, the total balance
    // is fixed and off-chain state updates rely on this invariant. Allowing
    // deposits while active would let a party front-run dispute/update
    // transactions by depositing dust, breaking the balance-sum assertion.
    assert!(tunnel.status == STATUS_CREATED, ETunnelClosed);

    let amount = coin.value();
    assert!(amount >= MIN_DEPOSIT, EMinimumDepositNotMet);

    if (is_party_a) {
        tunnel.party_a_deposit = tunnel.party_a_deposit + amount;
    } else {
        tunnel.party_b_deposit = tunnel.party_b_deposit + amount;
    };
    tunnel.balance.join(coin.into_balance());
    tunnel.last_activity = clock.timestamp_ms();

    let party = if (is_party_a) { tunnel.party_a.address } else { tunnel.party_b.address };
    event::emit(TunnelDeposit {
        tunnel_id: object::id(tunnel),
        party,
        amount,
        total_balance: tunnel.balance.value(),
    });

    // Auto-activate if both parties have deposited
    maybe_activate(tunnel, clock);
}

/// Internal: Activate tunnel if both parties have deposited.
/// Initializes state balances to the deposit amounts so that a dispute
/// raised before the first explicit state update has valid balances.
fun maybe_activate<T>(tunnel: &mut Tunnel<T>, clock: &Clock) {
    if (
        tunnel.status == STATUS_CREATED &&
        tunnel.party_a_deposit > 0 &&
        tunnel.party_b_deposit > 0
    ) {
        tunnel.status = STATUS_ACTIVE;
        tunnel.state.party_a_balance = tunnel.party_a_deposit;
        tunnel.state.party_b_balance = tunnel.party_b_deposit;

        event::emit(TunnelActivated {
            tunnel_id: object::id(tunnel),
            party_a_deposit: tunnel.party_a_deposit,
            party_b_deposit: tunnel.party_b_deposit,
            activated_at: clock.timestamp_ms(),
        });
    }
}

// ============================================
// STATE UPDATE FUNCTIONS
// ============================================

/// Assert that a settlement splits exactly `total` between the two parties.
/// Written without `party_a_balance + party_b_balance` so a crafted, overflowing
/// pair (which could wrap past `u64::MAX` to equal `total`) cannot satisfy the
/// check: `party_a_balance <= total` guarantees `total - party_a_balance` does
/// not underflow, and the equality then pins `party_b_balance` exactly.
fun assert_balance_split(party_a_balance: u64, party_b_balance: u64, total: u64) {
    assert!(party_a_balance <= total, EBalanceSumMismatch);
    assert!(party_b_balance == total - party_a_balance, EBalanceSumMismatch);
}

/// Update the on-chain state commitment.
/// Requires signatures from both parties on the new state.
///
/// ## Parameters
/// - `tunnel`: The tunnel to update
/// - `new_state_hash`: Hash of the new off-chain state
/// - `new_nonce`: New nonce (must be > current nonce)
/// - `party_a_balance`: Balance allocated to party A in this state
/// - `party_b_balance`: Balance allocated to party B in this state
/// - `timestamp`: Timestamp agreed off-chain when signatures were created
/// - `sig_a`: Signature from party A
/// - `sig_b`: Signature from party B
/// - `clock`: Clock for timestamp validation
public fun update_state<T>(
    tunnel: &mut Tunnel<T>,
    new_state_hash: vector<u8>,
    new_nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_ACTIVE, EInvalidState);
    // The signed state hash is a 32-byte commitment (blake2b256); reject any
    // other length so a degenerate (e.g. empty) hash cannot be co-signed.
    assert!(new_state_hash.length() == 32, EInvalidHash);
    assert!(new_nonce > tunnel.state.nonce, EInvalidNonce);

    // Validate balances sum to total
    let total = tunnel.balance.value();
    assert_balance_split(party_a_balance, party_b_balance, total);

    let now = clock.timestamp_ms();
    // Validate timestamp is reasonable
    assert!(timestamp <= now, EInvalidParameter);
    assert!(timestamp >= tunnel.created_at, EInvalidParameter);

    let tunnel_id = object::id(tunnel);

    // Create the data that was signed
    let update_data = StateUpdateData {
        tunnel_id,
        state_hash: new_state_hash,
        nonce: new_nonce,
        timestamp,
        party_a_balance,
        party_b_balance,
    };

    // Serialize the update data for verification
    let message = serialize_state_update(&update_data);

    // Verify both signatures
    assert!(
        signature::verify(
            tunnel.party_a.signature_type,
            &tunnel.party_a.public_key,
            &message,
            &sig_a,
        ),
        EInvalidSignature,
    );

    assert!(
        signature::verify(
            tunnel.party_b.signature_type,
            &tunnel.party_b.public_key,
            &message,
            &sig_b,
        ),
        EInvalidSignature,
    );

    // Update state
    tunnel.state =
        StateCommitment {
            state_hash: new_state_hash,
            nonce: new_nonce,
            timestamp: now,
            party_a_balance,
            party_b_balance,
        };
    tunnel.last_activity = now;

    event::emit(StateUpdated {
        tunnel_id,
        state_hash: new_state_hash,
        nonce: new_nonce,
        timestamp: now,
    });
}

// ============================================
// SETTLEMENT FUNCTIONS
// ============================================

/// Close the tunnel cooperatively with agreed final balances.
/// Requires signatures from both parties on the settlement.
///
/// ## Parameters
/// - `tunnel`: The tunnel to close
/// - `party_a_balance`: Final balance for party A
/// - `party_b_balance`: Final balance for party B
/// - `sig_a`: Signature from party A
/// - `sig_b`: Signature from party B
/// - `clock`: Clock for timestamp
/// - `ctx`: Transaction context
///
/// Funds are transferred directly to each party via `public_transfer`
/// to prevent PTB interception on shared objects.
public fun close_cooperative<T>(
    tunnel: &mut Tunnel<T>,
    party_a_balance: u64,
    party_b_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_ACTIVE || tunnel.status == STATUS_CREATED, ETunnelClosed);

    // Validate balances sum correctly
    let total = tunnel.balance.value();
    assert_balance_split(party_a_balance, party_b_balance, total);

    // Both signatures are always required. For unilateral withdrawal before
    // activation (one party deposited, other hasn't), use withdraw_before_active.
    assert!(!sig_a.is_empty() && !sig_b.is_empty(), EInvalidSignature);

    let now = clock.timestamp_ms();
    let tunnel_id = object::id(tunnel);
    let final_nonce = tunnel.state.nonce + 1;

    // Validate caller-provided settlement timestamp
    assert!(timestamp <= now, EInvalidParameter);
    assert!(timestamp >= tunnel.created_at, EInvalidParameter);

    // Create settlement data with the pre-agreed timestamp
    let settlement = SettlementData {
        tunnel_id,
        party_a_balance,
        party_b_balance,
        final_nonce,
        timestamp,
    };

    // Serialize for verification
    let message = serialize_settlement(&settlement);

    // Verify both signatures
    assert!(
        signature::verify(
            tunnel.party_a.signature_type,
            &tunnel.party_a.public_key,
            &message,
            &sig_a,
        ),
        EInvalidSignature,
    );

    assert!(
        signature::verify(
            tunnel.party_b.signature_type,
            &tunnel.party_b.public_key,
            &message,
            &sig_b,
        ),
        EInvalidSignature,
    );

    // Update status
    tunnel.status = STATUS_CLOSED;
    tunnel.last_activity = now;

    // Distribute funds directly to parties (prevents PTB interception)
    let coin_a = coin::from_balance(tunnel.balance.split(party_a_balance), ctx);
    let coin_b = coin::from_balance(tunnel.balance.split(party_b_balance), ctx);

    transfer::public_transfer(coin_a, tunnel.party_a.address);
    transfer::public_transfer(coin_b, tunnel.party_b.address);

    event::emit(TunnelClosed {
        tunnel_id,
        party_a_balance,
        party_b_balance,
        final_nonce,
        closed_at: now,
    });
}

/// Cooperative close that additionally anchors a 32-byte Merkle root of the off-chain
/// transcript into the signed settlement (proof-of-existence + compressed-transcript
/// settlement, Deliverable 7/8). Both parties sign serialize_settlement_with_root, so the
/// root is mutually agreed. Identical fund flow to close_cooperative otherwise. To settle
/// many tunnels in one transaction, a PTB simply calls this (or close_cooperative) once per
/// tunnel — no on-chain loop over shared objects is required.
public fun close_cooperative_with_root<T>(
    tunnel: &mut Tunnel<T>,
    party_a_balance: u64,
    party_b_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    transcript_root: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_ACTIVE || tunnel.status == STATUS_CREATED, ETunnelClosed);
    assert!(transcript_root.length() == 32, EInvalidTranscriptRoot);

    let total = tunnel.balance.value();
    assert_balance_split(party_a_balance, party_b_balance, total);
    assert!(!sig_a.is_empty() && !sig_b.is_empty(), EInvalidSignature);

    let now = clock.timestamp_ms();
    let tunnel_id = object::id(tunnel);
    let final_nonce = tunnel.state.nonce + 1;
    assert!(timestamp <= now, EInvalidParameter);
    assert!(timestamp >= tunnel.created_at, EInvalidParameter);

    let settlement = SettlementWithRootData {
        tunnel_id,
        party_a_balance,
        party_b_balance,
        final_nonce,
        timestamp,
        transcript_root,
    };
    let message = serialize_settlement_with_root(&settlement);

    assert!(
        signature::verify(
            tunnel.party_a.signature_type,
            &tunnel.party_a.public_key,
            &message,
            &sig_a,
        ),
        EInvalidSignature,
    );
    assert!(
        signature::verify(
            tunnel.party_b.signature_type,
            &tunnel.party_b.public_key,
            &message,
            &sig_b,
        ),
        EInvalidSignature,
    );

    tunnel.status = STATUS_CLOSED;
    tunnel.last_activity = now;

    let coin_a = coin::from_balance(tunnel.balance.split(party_a_balance), ctx);
    let coin_b = coin::from_balance(tunnel.balance.split(party_b_balance), ctx);
    transfer::public_transfer(coin_a, tunnel.party_a.address);
    transfer::public_transfer(coin_b, tunnel.party_b.address);

    event::emit(TunnelClosedWithRoot {
        tunnel_id,
        party_a_balance,
        party_b_balance,
        final_nonce,
        transcript_root: settlement.transcript_root,
        closed_at: now,
    });
}

/// Close and transfer funds to parties (alias for close_cooperative)
public fun close_cooperative_and_transfer<T>(
    tunnel: &mut Tunnel<T>,
    party_a_balance: u64,
    party_b_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    close_cooperative(
        tunnel,
        party_a_balance,
        party_b_balance,
        sig_a,
        sig_b,
        timestamp,
        clock,
        ctx,
    );
}

// ============================================
// DISPUTE FUNCTIONS
// ============================================

/// Raise a dispute with a signed state.
/// This puts the tunnel in disputed status and starts the dispute period.
/// The submitted balances are stored and used for settlement if the dispute
/// times out (force_close_after_timeout).
///
/// ## Parameters
/// - `tunnel`: The tunnel in dispute
/// - `state_hash`: The state hash being submitted
/// - `nonce`: The nonce of this state
/// - `party_a_balance`: Balance for party A in this signed state
/// - `party_b_balance`: Balance for party B in this signed state
/// - `timestamp`: The timestamp from when the state was originally co-signed
/// - `other_party_sig`: Signature from the other party on this state
/// - `clock`: Clock for current time
/// - `ctx`: Transaction context
public fun raise_dispute<T>(
    tunnel: &mut Tunnel<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    other_party_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_ACTIVE, EInvalidState);
    assert!(state_hash.length() == 32, EInvalidHash);
    // timeout_ms > 0 is enforced by create(), so no need to re-check here.

    // Validate balances match current total
    let total = tunnel.balance.value();
    assert_balance_split(party_a_balance, party_b_balance, total);

    // Determine which party is raising the dispute
    let sender = ctx.sender();
    let (_is_party_a, other_party) = if (sender == tunnel.party_a.address) {
        (true, &tunnel.party_b)
    } else if (sender == tunnel.party_b.address) {
        (false, &tunnel.party_a)
    } else {
        abort ENotAuthorized
    };

    // The submitted state must be newer than current
    assert!(nonce > tunnel.state.nonce, EStaleState);

    let now = clock.timestamp_ms();

    // Validate the provided timestamp
    assert!(timestamp <= now, EInvalidParameter);
    assert!(timestamp >= tunnel.created_at, EInvalidParameter);

    // Create state update data for verification using the original timestamp
    let update_data = StateUpdateData {
        tunnel_id: object::id(tunnel),
        state_hash,
        nonce,
        timestamp,
        party_a_balance,
        party_b_balance,
    };

    let message = serialize_state_update(&update_data);

    // Verify the other party signed this state
    // (proves they agreed to this state at some point)
    assert!(
        signature::verify(
            other_party.signature_type,
            &other_party.public_key,
            &message,
            &other_party_sig,
        ),
        EInvalidSignature,
    );

    // Update to disputed state with stored balances
    tunnel.status = STATUS_DISPUTED;
    tunnel.dispute_raiser = option::some(sender);
    tunnel.state =
        StateCommitment {
            state_hash,
            nonce,
            timestamp: now,
            party_a_balance,
            party_b_balance,
        };
    tunnel.last_activity = now;

    event::emit(DisputeRaised {
        tunnel_id: object::id(tunnel),
        raised_by: sender,
        state_hash,
        nonce,
        timestamp: now,
    });
}

/// Resolve a dispute by submitting a newer signed state.
/// If successful, updates the state and returns tunnel to active.
///
/// ## Parameters
/// - `tunnel`: The disputed tunnel
/// - `state_hash`: The state hash of the newer state
/// - `nonce`: The nonce of the newer state
/// - `party_a_balance`: Balance for party A in this newer state
/// - `party_b_balance`: Balance for party B in this newer state
/// - `timestamp`: The timestamp from when the state was originally co-signed
/// - `sig_a`: Signature from party A on this state
/// - `sig_b`: Signature from party B on this state
/// - `clock`: Clock for current time
public fun resolve_dispute<T>(
    tunnel: &mut Tunnel<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_DISPUTED, ENoActiveDispute);
    assert!(state_hash.length() == 32, EInvalidHash);

    // Must submit a newer state
    assert!(nonce > tunnel.state.nonce, EStaleState);

    // Validate balances match current total
    let total = tunnel.balance.value();
    assert_balance_split(party_a_balance, party_b_balance, total);

    let now = clock.timestamp_ms();

    // Validate the provided timestamp
    assert!(timestamp <= now, EInvalidParameter);
    assert!(timestamp >= tunnel.created_at, EInvalidParameter);

    // Create state update data using the original timestamp
    let update_data = StateUpdateData {
        tunnel_id: object::id(tunnel),
        state_hash,
        nonce,
        timestamp,
        party_a_balance,
        party_b_balance,
    };

    let message = serialize_state_update(&update_data);

    // Verify both signatures
    assert!(
        signature::verify(
            tunnel.party_a.signature_type,
            &tunnel.party_a.public_key,
            &message,
            &sig_a,
        ),
        EInvalidSignature,
    );

    assert!(
        signature::verify(
            tunnel.party_b.signature_type,
            &tunnel.party_b.public_key,
            &message,
            &sig_b,
        ),
        EInvalidSignature,
    );

    // Update state and return to active
    tunnel.status = STATUS_ACTIVE;
    tunnel.state =
        StateCommitment {
            state_hash,
            nonce,
            timestamp: now,
            party_a_balance,
            party_b_balance,
        };
    tunnel.last_activity = now;

    event::emit(DisputeResolved {
        tunnel_id: object::id(tunnel),
        state_hash,
        nonce,
        party_a_balance,
        party_b_balance,
        timestamp: now,
    });
}

/// Raise a dispute using the current on-chain state.
/// Used when no off-chain state updates have been exchanged yet (nonce == 0),
/// or when a party needs to re-dispute after `resolve_dispute` returned the
/// tunnel to ACTIVE status and the counterparty stopped responding.
///
/// Unlike `raise_dispute`, this does NOT require a co-signed state because
/// the current on-chain balances were either set during activation (initial
/// deposits) or verified via dual signatures in a prior `update_state` or
/// `resolve_dispute` call.
///
/// ## Liveness requirement
/// This (like `raise_dispute`) forces settlement on the CURRENT on-chain state
/// after `timeout_ms`. If newer co-signed states exist off-chain, the
/// counterparty MUST be online to submit one via `resolve_dispute` (or accept
/// the current state via `agree_to_dispute`) before the timeout elapses. A
/// party that goes offline can therefore be forced onto a stale on-chain state.
/// Because raising a dispute has no intrinsic cost when `penalty_amount == 0`,
/// deployments that need anti-griefing should configure a non-zero penalty.
public fun raise_dispute_current_state<T>(tunnel: &mut Tunnel<T>, clock: &Clock, ctx: &TxContext) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_ACTIVE, EInvalidState);
    assert!(tunnel.timeout_ms > 0, ENotSupported);

    let sender = ctx.sender();
    assert!(sender == tunnel.party_a.address || sender == tunnel.party_b.address, ENotAuthorized);

    let now = clock.timestamp_ms();
    tunnel.status = STATUS_DISPUTED;
    tunnel.dispute_raiser = option::some(sender);
    tunnel.state.timestamp = now; // Reset timeout clock
    tunnel.last_activity = now;

    event::emit(DisputeRaised {
        tunnel_id: object::id(tunnel),
        raised_by: sender,
        state_hash: tunnel.state.state_hash,
        nonce: tunnel.state.nonce,
        timestamp: now,
    });
}

/// Force close a tunnel after dispute timeout.
/// Only the dispute raiser can call this after the dispute timeout has elapsed.
/// Uses the balance distribution from the disputed state (stored during
/// `raise_dispute`), preventing the dispute raiser from arbitrarily choosing
/// a split. The counterparty's recourse is to resolve the dispute before
/// timeout by calling `resolve_dispute` with a more recent mutually-signed
/// state, or `agree_to_dispute` to accept the current state immediately.
public fun force_close_after_timeout<T>(
    tunnel: &mut Tunnel<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_DISPUTED, ENoActiveDispute);
    assert!(tunnel.timeout_ms > 0, ENotSupported);

    // Only the dispute raiser can force close after timeout
    let sender = ctx.sender();
    assert!(tunnel.dispute_raiser.is_some(), ENotAuthorized);
    assert!(sender == *tunnel.dispute_raiser.borrow(), ENotAuthorized);

    let now = clock.timestamp_ms();
    let dispute_start = tunnel.state.timestamp;

    // Check timeout has passed
    assert!(now >= dispute_start + tunnel.timeout_ms, ETimeoutNotReached);

    // The disputed state's balances are already net of any HTLC-locked funds
    // (each `lock_htlc` debits them and splits the amount into a separate
    // dynamic field), so they distribute the full remaining tunnel balance
    // directly. Outstanding HTLCs are resolved independently (claim or expire)
    // after the tunnel closes.
    let mut party_a_balance = tunnel.state.party_a_balance;
    let mut party_b_balance = tunnel.state.party_b_balance;

    // Apply penalty: the dispute raiser waited through the timeout, so they
    // get compensated from the non-responding party's balance. The penalty
    // is capped at the non-raiser's available balance to prevent underflow.
    if (tunnel.penalty_amount > 0) {
        let raiser = *tunnel.dispute_raiser.borrow();
        if (raiser == tunnel.party_a.address) {
            let actual_penalty = tunnel.penalty_amount.min(party_b_balance);
            party_b_balance = party_b_balance - actual_penalty;
            party_a_balance = party_a_balance + actual_penalty;
        } else {
            let actual_penalty = tunnel.penalty_amount.min(party_a_balance);
            party_a_balance = party_a_balance - actual_penalty;
            party_b_balance = party_b_balance + actual_penalty;
        };
    };

    // Validate adjusted balances match current tunnel balance
    let total = tunnel.balance.value();
    assert_balance_split(party_a_balance, party_b_balance, total);

    // Close the tunnel
    tunnel.status = STATUS_CLOSED;
    tunnel.last_activity = now;

    // Distribute funds directly to parties (prevents PTB interception)
    let coin_a = coin::from_balance(tunnel.balance.split(party_a_balance), ctx);
    let coin_b = coin::from_balance(tunnel.balance.split(party_b_balance), ctx);

    transfer::public_transfer(coin_a, tunnel.party_a.address);
    transfer::public_transfer(coin_b, tunnel.party_b.address);

    event::emit(TunnelClosed {
        tunnel_id: object::id(tunnel),
        party_a_balance,
        party_b_balance,
        final_nonce: tunnel.state.nonce,
        closed_at: now,
    });
}

/// Agree to the disputed state, skipping the timeout period.
/// Only the non-dispute-raiser party can call this. Immediately closes the
/// tunnel using the stored balances from the disputed state.
/// This improves UX when the counterparty agrees the disputed state is correct,
/// avoiding an unnecessary timeout wait.
public fun agree_to_dispute<T>(tunnel: &mut Tunnel<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_DISPUTED, ENoActiveDispute);

    // Only the non-dispute-raiser can agree
    let sender = ctx.sender();
    assert!(tunnel.dispute_raiser.is_some(), ENotAuthorized);
    let raiser = *tunnel.dispute_raiser.borrow();
    assert!(sender != raiser, ENotAuthorized);
    assert!(sender == tunnel.party_a.address || sender == tunnel.party_b.address, ENotAuthorized);

    // The disputed state's balances are already net of HTLC-locked funds, so
    // they distribute the full remaining tunnel balance directly (see
    // `force_close_after_timeout`).
    let party_a_balance = tunnel.state.party_a_balance;
    let party_b_balance = tunnel.state.party_b_balance;
    let total = tunnel.balance.value();
    assert_balance_split(party_a_balance, party_b_balance, total);

    let now = clock.timestamp_ms();
    tunnel.status = STATUS_CLOSED;
    tunnel.last_activity = now;

    let coin_a = coin::from_balance(tunnel.balance.split(party_a_balance), ctx);
    let coin_b = coin::from_balance(tunnel.balance.split(party_b_balance), ctx);

    transfer::public_transfer(coin_a, tunnel.party_a.address);
    transfer::public_transfer(coin_b, tunnel.party_b.address);

    event::emit(TunnelClosed {
        tunnel_id: object::id(tunnel),
        party_a_balance,
        party_b_balance,
        final_nonce: tunnel.state.nonce,
        closed_at: now,
    });
}

// ============================================
// TIMEOUT EXTENSION
// ============================================

/// Extends the tunnel's dispute timeout by an additional duration.
/// Either party can call this to accommodate long-lived channels.
/// Works on active or disputed tunnels.
public fun extend_timeout<T>(
    tunnel: &mut Tunnel<T>,
    additional_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_ACTIVE || tunnel.status == STATUS_DISPUTED, EInvalidState);
    assert!(additional_ms > 0, EInvalidParameter);

    let sender = ctx.sender();
    assert!(sender == tunnel.party_a.address || sender == tunnel.party_b.address, ENotAuthorized);

    tunnel.timeout_ms = tunnel.timeout_ms + additional_ms;
    tunnel.last_activity = clock.timestamp_ms();

    event::emit(TunnelTimeoutExtended {
        tunnel_id: object::id(tunnel),
        extended_by: sender,
        additional_ms,
        new_timeout_ms: tunnel.timeout_ms,
        timestamp: tunnel.last_activity,
    });
}

// ============================================
// HTLC FUNCTIONS
// ============================================

/// Lock an HTLC within a tunnel. Splits funds from the tunnel's balance
/// into a dynamic field. The counterparty must have signed the HTLC terms.
///
/// This enables on-chain HTLC enforcement for multi-hop payments:
/// 1. Alice locks HTLC in Alice-Bob tunnel
/// 2. Bob locks HTLC in Bob-Charlie tunnel (same payment_hash)
/// 3. Charlie claims with preimage from Bob's tunnel
/// 4. Bob sees preimage on-chain, claims from Alice's tunnel
public fun lock_htlc<T>(
    tunnel: &mut Tunnel<T>,
    payment_hash: vector<u8>,
    amount: u64,
    receiver: address,
    expiry_ms: u64,
    counterparty_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_ACTIVE, EInvalidState);
    assert!(amount > 0, EInvalidParameter);
    assert!(payment_hash.length() == 32, EInvalidHash);

    let now = clock.timestamp_ms();
    assert!(expiry_ms > now, EInvalidTimeout);

    let sender = ctx.sender();
    let (is_party_a, counterparty) = if (sender == tunnel.party_a.address) {
        (true, &tunnel.party_b)
    } else if (sender == tunnel.party_b.address) {
        (false, &tunnel.party_a)
    } else {
        abort ENotAuthorized
    };

    // Verify counterparty signed the HTLC terms
    let lock_data = HTLCLockData {
        tunnel_id: object::id(tunnel),
        payment_hash,
        amount,
        sender,
        receiver,
        expiry_ms,
    };
    let message = serialize_htlc_lock(&lock_data);

    assert!(
        signature::verify(
            counterparty.signature_type,
            &counterparty.public_key,
            &message,
            &counterparty_sig,
        ),
        EInvalidSignature,
    );

    lock_htlc_internal(tunnel, payment_hash, amount, sender, receiver, expiry_ms, is_party_a, now);
}

/// Internal: record an HTLC lock once authorization has been established.
/// Splits `amount` out of the combined tunnel balance into a dedicated dynamic
/// field, debits the sender's net state balance (preserving the
/// `party_a_balance + party_b_balance == tunnel.balance.value()` invariant), and
/// bumps the informational per-party locked counter.
fun lock_htlc_internal<T>(
    tunnel: &mut Tunnel<T>,
    payment_hash: vector<u8>,
    amount: u64,
    sender: address,
    receiver: address,
    expiry_ms: u64,
    is_party_a: bool,
    now: u64,
) {
    // The sender's recorded state balance is already net of any previously
    // locked HTLC funds, so it directly bounds what can still be locked.
    let sender_balance = if (is_party_a) {
        tunnel.state.party_a_balance
    } else {
        tunnel.state.party_b_balance
    };
    assert!(amount <= sender_balance, EInsufficientBalance);

    // Ensure no duplicate HTLC
    let key = HTLCKey { payment_hash };
    assert!(!df::exists(&tunnel.id, key), EAlreadyExists);

    // Split funds from the tunnel balance into the HTLC
    let htlc_balance = tunnel.balance.split(amount);
    df::add(
        &mut tunnel.id,
        key,
        TunnelHTLC<T> {
            payment_hash,
            amount,
            sender,
            receiver,
            expiry_ms,
            balance: htlc_balance,
        },
    );

    // Update per-party counter (informational; surfaced via `party_htlc_locked`).
    update_party_htlc_counter(tunnel, sender, true, amount);

    // Debit the sender's net state balance so the core invariant
    // `party_a_balance + party_b_balance == tunnel.balance.value()` is preserved
    // now that `amount` has been split out of the combined tunnel balance.
    if (is_party_a) {
        tunnel.state.party_a_balance = tunnel.state.party_a_balance - amount;
    } else {
        tunnel.state.party_b_balance = tunnel.state.party_b_balance - amount;
    };
    tunnel.last_activity = now;

    event::emit(HTLCLocked {
        tunnel_id: object::id(tunnel),
        payment_hash,
        amount,
        sender,
        receiver,
        expiry_ms,
    });
}

/// Claim an HTLC with the preimage. Funds are transferred to the receiver.
/// Only the designated receiver can claim. Works even after the tunnel is
/// closed or disputed, since HTLC funds are in a separate dynamic field.
public fun claim_htlc_in_tunnel<T>(
    tunnel: &mut Tunnel<T>,
    payment_hash: vector<u8>,
    preimage: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status != STATUS_DESTROYED, EInvalidState);

    let key = HTLCKey { payment_hash };
    assert!(df::exists(&tunnel.id, key), ENotFound);

    let htlc: TunnelHTLC<T> = df::remove(&mut tunnel.id, key);

    // Only receiver can claim
    assert!(ctx.sender() == htlc.receiver, ENotAuthorized);

    // Verify preimage matches payment hash
    let computed_hash = hash::blake2b256(&preimage);
    assert!(computed_hash == htlc.payment_hash, EInvalidPreimage);

    // Must not be expired
    let now = clock.timestamp_ms();
    assert!(now < htlc.expiry_ms, EHtlcExpired);

    let amount = htlc.amount;
    let claimed_by = htlc.receiver;
    let htlc_sender = htlc.sender;

    // Transfer HTLC funds to receiver
    let TunnelHTLC { balance, .. } = htlc;
    let coin = coin::from_balance(balance, ctx);
    transfer::public_transfer(coin, claimed_by);

    // Decrement sender's locked counter
    update_party_htlc_counter(tunnel, htlc_sender, false, amount);
    tunnel.last_activity = now;

    event::emit(HTLCClaimedInTunnel {
        tunnel_id: object::id(tunnel),
        payment_hash,
        amount,
        claimed_by,
    });
}

/// Expire an HTLC after its timeout and return funds to the sender.
/// Only the HTLC sender can call this. Works even after tunnel close.
public fun expire_htlc_in_tunnel<T>(
    tunnel: &mut Tunnel<T>,
    payment_hash: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status != STATUS_DESTROYED, EInvalidState);

    let key = HTLCKey { payment_hash };
    assert!(df::exists(&tunnel.id, key), ENotFound);

    let htlc: TunnelHTLC<T> = df::remove(&mut tunnel.id, key);

    // Must be expired
    let now = clock.timestamp_ms();
    assert!(now >= htlc.expiry_ms, EHtlcNotExpired);

    // Only sender can reclaim expired HTLC
    assert!(ctx.sender() == htlc.sender, ENotAuthorized);

    let amount = htlc.amount;
    let returned_to = htlc.sender;

    // Transfer HTLC funds back to sender
    let TunnelHTLC { balance, .. } = htlc;
    let coin = coin::from_balance(balance, ctx);
    transfer::public_transfer(coin, returned_to);

    // Decrement sender's locked counter
    update_party_htlc_counter(tunnel, returned_to, false, amount);
    tunnel.last_activity = now;

    event::emit(HTLCExpiredInTunnel {
        tunnel_id: object::id(tunnel),
        payment_hash,
        amount,
        returned_to,
    });
}

/// Internal: get total HTLC-locked amount for a party
fun get_party_htlc_locked<T>(tunnel: &Tunnel<T>, party: address): u64 {
    let key = HTLCPartyCounterKey { party };
    if (df::exists(&tunnel.id, key)) {
        let counter: &HTLCPartyCounter = df::borrow(&tunnel.id, key);
        counter.total_locked
    } else {
        0
    }
}

/// Internal: update per-party HTLC counter
fun update_party_htlc_counter<T>(
    tunnel: &mut Tunnel<T>,
    party: address,
    adding: bool,
    amount: u64,
) {
    let key = HTLCPartyCounterKey { party };
    if (!df::exists(&tunnel.id, key)) {
        df::add(&mut tunnel.id, key, HTLCPartyCounter { count: 0, total_locked: 0 });
    };
    let counter: &mut HTLCPartyCounter = df::borrow_mut(&mut tunnel.id, key);
    if (adding) {
        counter.count = counter.count + 1;
        counter.total_locked = counter.total_locked + amount;
    } else {
        counter.count = counter.count - 1;
        counter.total_locked = counter.total_locked - amount;
    }
}

// ============================================
// REFEREE FUNCTIONS
// ============================================

/// Assign a referee to the tunnel for pluggable dispute resolution.
/// Only allowed during CREATED status so both parties can verify
/// the referee before committing funds.
///
/// Enables three dispute resolution strategies:
/// - Simple timeout referee (cheapest)
/// - Committee referee (for high-value channels)
/// - ZK referee (instant finality with proof)
public fun set_referee<T>(tunnel: &mut Tunnel<T>, referee: address, ctx: &TxContext) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_CREATED, EInvalidState);

    let sender = ctx.sender();
    assert!(sender == tunnel.party_a.address || sender == tunnel.party_b.address, ENotAuthorized);

    let key = RefereeKey {};
    if (df::exists(&tunnel.id, key)) {
        *df::borrow_mut<RefereeKey, address>(&mut tunnel.id, key) = referee;
    } else {
        df::add(&mut tunnel.id, key, referee);
    };

    event::emit(RefereeAssigned {
        tunnel_id: object::id(tunnel),
        referee,
    });
}

/// Resolve a dispute using the designated external referee.
/// Only the assigned referee can call this. The referee determines
/// the final balance distribution.
///
/// Funds are transferred directly to each party via `public_transfer`
/// to prevent PTB interception on shared objects.
public fun resolve_dispute_external<T>(
    tunnel: &mut Tunnel<T>,
    party_a_balance: u64,
    party_b_balance: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_DISPUTED, ENoActiveDispute);

    let key = RefereeKey {};
    assert!(df::exists(&tunnel.id, key), ENotSupported);
    let referee: address = *df::borrow(&tunnel.id, key);
    assert!(ctx.sender() == referee, ERefereeNotAuthorized);

    // `tunnel.balance` is already net of HTLC-locked funds (split into separate
    // dynamic fields at lock time), so the referee distributes the full
    // remaining balance. Outstanding HTLCs settle independently.
    let total = tunnel.balance.value();
    assert_balance_split(party_a_balance, party_b_balance, total);

    let now = clock.timestamp_ms();
    tunnel.status = STATUS_CLOSED;
    tunnel.last_activity = now;

    // Distribute funds
    let coin_a = coin::from_balance(tunnel.balance.split(party_a_balance), ctx);
    let coin_b = coin::from_balance(tunnel.balance.split(party_b_balance), ctx);

    transfer::public_transfer(coin_a, tunnel.party_a.address);
    transfer::public_transfer(coin_b, tunnel.party_b.address);

    event::emit(DisputeResolvedByReferee {
        tunnel_id: object::id(tunnel),
        referee,
        party_a_balance,
        party_b_balance,
        timestamp: now,
    });
}

/// Resolve a dispute after package-local proof verification.
///
/// This intentionally bypasses the trusted-address referee path. It is package
/// visible so only a verifier module in `sui_tunnel` can call it after checking a
/// native Groth16 proof and binding the proof inputs to the disputed tunnel state.
///
/// Like `force_close_after_timeout`, this can only settle once the dispute
/// timeout has elapsed: the proof attests the OUTCOME for a given state, not that
/// the state is the latest one both parties agreed to.
public(package) fun resolve_dispute_verified<T>(
    tunnel: &mut Tunnel<T>,
    party_a_balance: u64,
    party_b_balance: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_DISPUTED, ENoActiveDispute);
    assert!(tunnel.timeout_ms > 0, ENotSupported);

    // Enforce the dispute challenge window before forcing settlement.
    let now = clock.timestamp_ms();
    assert!(now >= tunnel.state.timestamp + tunnel.timeout_ms, ETimeoutNotReached);

    // `tunnel.balance` is already net of HTLC-locked funds (split into separate
    // dynamic fields at lock time), so the verifier distributes the full
    // remaining balance. Outstanding HTLCs settle independently.
    let total = tunnel.balance.value();
    assert_balance_split(party_a_balance, party_b_balance, total);

    tunnel.status = STATUS_CLOSED;
    tunnel.last_activity = now;

    let coin_a = coin::from_balance(tunnel.balance.split(party_a_balance), ctx);
    let coin_b = coin::from_balance(tunnel.balance.split(party_b_balance), ctx);

    transfer::public_transfer(coin_a, tunnel.party_a.address);
    transfer::public_transfer(coin_b, tunnel.party_b.address);

    event::emit(DisputeResolvedByVerifiedProof {
        tunnel_id: object::id(tunnel),
        party_a_balance,
        party_b_balance,
        timestamp: now,
    });
}

// ============================================
// WITHDRAWAL FUNCTIONS
// ============================================

/// Withdraw own deposit before tunnel becomes active.
/// Only allowed when tunnel is STATUS_CREATED and the other party has zero deposit.
public fun withdraw_before_active<T>(
    tunnel: &mut Tunnel<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_CREATED, EInvalidState);

    let sender = ctx.sender();
    let (my_deposit, other_deposit, is_party_a) = if (sender == tunnel.party_a.address) {
        (tunnel.party_a_deposit, tunnel.party_b_deposit, true)
    } else if (sender == tunnel.party_b.address) {
        (tunnel.party_b_deposit, tunnel.party_a_deposit, false)
    } else {
        abort ENotAuthorized
    };

    assert!(my_deposit > 0, EInsufficientBalance);
    assert!(other_deposit == 0, EInvalidState);

    let now = clock.timestamp_ms();
    let amount = my_deposit;

    if (is_party_a) {
        tunnel.party_a_deposit = 0;
    } else {
        tunnel.party_b_deposit = 0;
    };

    let coin = coin::from_balance(tunnel.balance.split(amount), ctx);
    tunnel.last_activity = now;

    // Close the tunnel since balance is now zero
    if (tunnel.balance.value() == 0) {
        tunnel.status = STATUS_CLOSED;
    };

    event::emit(TunnelWithdrawal {
        tunnel_id: object::id(tunnel),
        party: sender,
        amount,
        timestamp: now,
    });

    coin
}

/// Withdraw own deposit after timeout when tunnel is still STATUS_CREATED.
/// Allows withdrawal regardless of the other party's deposit after timeout expires.
public fun withdraw_timeout<T>(
    tunnel: &mut Tunnel<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_CREATED, EInvalidState);
    assert!(tunnel.timeout_ms > 0, ENotSupported);

    let now = clock.timestamp_ms();
    assert!(now >= tunnel.created_at + tunnel.timeout_ms, ETimeoutNotReached);

    let sender = ctx.sender();
    let (my_deposit, is_party_a) = if (sender == tunnel.party_a.address) {
        (tunnel.party_a_deposit, true)
    } else if (sender == tunnel.party_b.address) {
        (tunnel.party_b_deposit, false)
    } else {
        abort ENotAuthorized
    };

    assert!(my_deposit > 0, EInsufficientBalance);

    let amount = my_deposit;
    if (is_party_a) {
        tunnel.party_a_deposit = 0;
    } else {
        tunnel.party_b_deposit = 0;
    };

    let coin = coin::from_balance(tunnel.balance.split(amount), ctx);
    tunnel.last_activity = now;

    // Close the tunnel if balance is now zero
    if (tunnel.balance.value() == 0) {
        tunnel.status = STATUS_CLOSED;
    };

    event::emit(TunnelWithdrawal {
        tunnel_id: object::id(tunnel),
        party: sender,
        amount,
        timestamp: now,
    });

    coin
}

// ============================================
// DESTROY FUNCTION
// ============================================

/// Destroy (tombstone) a closed tunnel with zero balance.
/// Only a tunnel party can call this.
public fun destroy_tunnel<T>(tunnel: &mut Tunnel<T>, clock: &Clock, ctx: &TxContext) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
    assert!(tunnel.status == STATUS_CLOSED, EInvalidState);
    assert!(tunnel.balance.value() == 0, EInsufficientBalance);

    let sender = ctx.sender();
    assert!(sender == tunnel.party_a.address || sender == tunnel.party_b.address, ENotAuthorized);

    tunnel.status = STATUS_DESTROYED;

    event::emit(TunnelDestroyed {
        tunnel_id: object::id(tunnel),
        destroyed_by: sender,
        timestamp: clock.timestamp_ms(),
    });
}

// ============================================
// ENTRY FUNCTION WRAPPERS
// ============================================

/// Entry wrapper for create_and_share
entry fun entry_create_and_share<T>(
    party_a_address: address,
    party_a_pk: vector<u8>,
    party_a_sig_type: u8,
    party_b_address: address,
    party_b_pk: vector<u8>,
    party_b_sig_type: u8,
    timeout_ms: u64,
    penalty_amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    create_and_share<T>(
        party_a_address,
        party_a_pk,
        party_a_sig_type,
        party_b_address,
        party_b_pk,
        party_b_sig_type,
        timeout_ms,
        penalty_amount,
        clock,
        ctx,
    );
}

/// Entry wrapper for deposit
entry fun entry_deposit<T>(tunnel: &mut Tunnel<T>, coin: Coin<T>, clock: &Clock, ctx: &TxContext) {
    deposit(tunnel, coin, clock, ctx);
}

/// Entry wrapper for close_cooperative_and_transfer
entry fun entry_close_cooperative<T>(
    tunnel: &mut Tunnel<T>,
    party_a_balance: u64,
    party_b_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    close_cooperative_and_transfer(
        tunnel,
        party_a_balance,
        party_b_balance,
        sig_a,
        sig_b,
        timestamp,
        clock,
        ctx,
    );
}

/// Entry wrapper for close_cooperative_with_root
entry fun entry_close_cooperative_with_root<T>(
    tunnel: &mut Tunnel<T>,
    party_a_balance: u64,
    party_b_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    transcript_root: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    close_cooperative_with_root(
        tunnel,
        party_a_balance,
        party_b_balance,
        sig_a,
        sig_b,
        timestamp,
        transcript_root,
        clock,
        ctx,
    );
}

/// Entry wrapper for raise_dispute
entry fun entry_raise_dispute<T>(
    tunnel: &mut Tunnel<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    other_party_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    raise_dispute(
        tunnel,
        state_hash,
        nonce,
        party_a_balance,
        party_b_balance,
        timestamp,
        other_party_sig,
        clock,
        ctx,
    );
}

/// Entry wrapper for the dual-signed resolve_dispute: override an open (possibly stale)
/// dispute by submitting the latest co-signed state. PTB-reachable so the honest party /
/// watchtower can defend against a stale-state dispute without an external referee.
entry fun entry_resolve_dispute<T>(
    tunnel: &mut Tunnel<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    resolve_dispute(
        tunnel,
        state_hash,
        nonce,
        party_a_balance,
        party_b_balance,
        timestamp,
        sig_a,
        sig_b,
        clock,
    );
}

/// Entry wrapper for raise_dispute_current_state
entry fun entry_raise_dispute_current_state<T>(
    tunnel: &mut Tunnel<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    raise_dispute_current_state(tunnel, clock, ctx);
}

/// Entry wrapper for update_state
entry fun entry_update_state<T>(
    tunnel: &mut Tunnel<T>,
    new_state_hash: vector<u8>,
    new_nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    update_state(
        tunnel,
        new_state_hash,
        new_nonce,
        party_a_balance,
        party_b_balance,
        timestamp,
        sig_a,
        sig_b,
        clock,
    );
}

/// Entry wrapper for force_close_after_timeout
entry fun entry_force_close<T>(tunnel: &mut Tunnel<T>, clock: &Clock, ctx: &mut TxContext) {
    force_close_after_timeout(tunnel, clock, ctx);
}

/// Entry wrapper for agree_to_dispute
entry fun entry_agree_to_dispute<T>(tunnel: &mut Tunnel<T>, clock: &Clock, ctx: &mut TxContext) {
    agree_to_dispute(tunnel, clock, ctx);
}

/// Entry wrapper for extend_timeout
entry fun entry_extend_timeout<T>(
    tunnel: &mut Tunnel<T>,
    additional_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    extend_timeout(tunnel, additional_ms, clock, ctx);
}

/// Entry wrapper for lock_htlc
entry fun entry_lock_htlc<T>(
    tunnel: &mut Tunnel<T>,
    payment_hash: vector<u8>,
    amount: u64,
    receiver: address,
    expiry_ms: u64,
    counterparty_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    lock_htlc(tunnel, payment_hash, amount, receiver, expiry_ms, counterparty_sig, clock, ctx);
}

/// Entry wrapper for claim_htlc_in_tunnel
entry fun entry_claim_htlc<T>(
    tunnel: &mut Tunnel<T>,
    payment_hash: vector<u8>,
    preimage: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    claim_htlc_in_tunnel(tunnel, payment_hash, preimage, clock, ctx);
}

/// Entry wrapper for expire_htlc_in_tunnel
entry fun entry_expire_htlc<T>(
    tunnel: &mut Tunnel<T>,
    payment_hash: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    expire_htlc_in_tunnel(tunnel, payment_hash, clock, ctx);
}

/// Entry wrapper for set_referee
entry fun entry_set_referee<T>(tunnel: &mut Tunnel<T>, referee: address, ctx: &TxContext) {
    set_referee(tunnel, referee, ctx);
}

/// Entry wrapper for resolve_dispute_external
entry fun entry_resolve_dispute_external<T>(
    tunnel: &mut Tunnel<T>,
    party_a_balance: u64,
    party_b_balance: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    resolve_dispute_external(tunnel, party_a_balance, party_b_balance, clock, ctx);
}

// ============================================
// SERIALIZATION FUNCTIONS
// ============================================

/// Serialize state update data for signing
public fun serialize_state_update(data: &StateUpdateData): vector<u8> {
    let mut result = b"sui_tunnel::state_update";
    result.append(data.tunnel_id.to_bytes());
    result.append(data.state_hash);
    result.append(signature::u64_to_be_bytes(data.nonce));
    result.append(signature::u64_to_be_bytes(data.timestamp));
    result.append(signature::u64_to_be_bytes(data.party_a_balance));
    result.append(signature::u64_to_be_bytes(data.party_b_balance));
    result
}

/// Serialize settlement data for signing
public fun serialize_settlement(data: &SettlementData): vector<u8> {
    let mut result = b"sui_tunnel::settlement";
    result.append(data.tunnel_id.to_bytes());
    result.append(signature::u64_to_be_bytes(data.party_a_balance));
    result.append(signature::u64_to_be_bytes(data.party_b_balance));
    result.append(signature::u64_to_be_bytes(data.final_nonce));
    result.append(signature::u64_to_be_bytes(data.timestamp));
    result
}

/// Serialize settlement-with-root data for signing. Distinct domain ("settlement_v2")
/// so a v1 signature can never be replayed as a v2 (root-anchored) settlement.
public fun serialize_settlement_with_root(data: &SettlementWithRootData): vector<u8> {
    let mut result = b"sui_tunnel::settlement_v2";
    result.append(data.tunnel_id.to_bytes());
    result.append(signature::u64_to_be_bytes(data.party_a_balance));
    result.append(signature::u64_to_be_bytes(data.party_b_balance));
    result.append(signature::u64_to_be_bytes(data.final_nonce));
    result.append(signature::u64_to_be_bytes(data.timestamp));
    result.append(data.transcript_root);
    result
}

/// Serialize HTLC lock data for signing
public fun serialize_htlc_lock(data: &HTLCLockData): vector<u8> {
    let mut result = b"sui_tunnel::htlc_lock";
    result.append(data.tunnel_id.to_bytes());
    result.append(data.payment_hash);
    result.append(signature::u64_to_be_bytes(data.amount));
    result.append(data.sender.to_bytes());
    result.append(data.receiver.to_bytes());
    result.append(signature::u64_to_be_bytes(data.expiry_ms));
    result
}

/// Create a state hash from arbitrary data
public fun create_state_hash(data: &vector<u8>): vector<u8> {
    hash::blake2b256(data)
}

// ============================================
// ACCESSOR FUNCTIONS
// ============================================

/// Get the current version constant
public fun current_version(): u64 { CURRENT_VERSION }

/// Get the tunnel's version
public fun version<T>(tunnel: &Tunnel<T>): u64 { tunnel.version }

/// Assert that the tunnel is at the current version
public fun assert_current_version<T>(tunnel: &Tunnel<T>) {
    assert!(tunnel.version == CURRENT_VERSION, EInvalidVersion);
}

/// Get the tunnel ID
public fun id<T>(tunnel: &Tunnel<T>): ID {
    object::id(tunnel)
}

/// Get party A's configuration
public fun party_a<T>(tunnel: &Tunnel<T>): &PartyConfig {
    &tunnel.party_a
}

/// Get party B's configuration
public fun party_b<T>(tunnel: &Tunnel<T>): &PartyConfig {
    &tunnel.party_b
}

/// Get party config address
public fun party_address(config: &PartyConfig): address {
    config.address
}

/// Get party config public key
public fun party_public_key(config: &PartyConfig): &vector<u8> {
    &config.public_key
}

/// Get party config signature type
public fun party_signature_type(config: &PartyConfig): u8 {
    config.signature_type
}

/// Get total balance in tunnel
public fun total_balance<T>(tunnel: &Tunnel<T>): u64 {
    tunnel.balance.value()
}

/// Get party A's deposit amount
public fun party_a_deposit<T>(tunnel: &Tunnel<T>): u64 {
    tunnel.party_a_deposit
}

/// Get party B's deposit amount
public fun party_b_deposit<T>(tunnel: &Tunnel<T>): u64 {
    tunnel.party_b_deposit
}

/// Get current tunnel status
public fun status<T>(tunnel: &Tunnel<T>): u8 {
    tunnel.status
}

/// Check if tunnel is active
public fun is_active<T>(tunnel: &Tunnel<T>): bool {
    tunnel.status == STATUS_ACTIVE
}

/// Check if tunnel is closed
public fun is_closed<T>(tunnel: &Tunnel<T>): bool {
    tunnel.status == STATUS_CLOSED
}

/// Check if tunnel is disputed
public fun is_disputed<T>(tunnel: &Tunnel<T>): bool {
    tunnel.status == STATUS_DISPUTED
}

/// Get the current state commitment
public fun state<T>(tunnel: &Tunnel<T>): &StateCommitment {
    &tunnel.state
}

/// Get state hash from commitment
public fun state_hash(commitment: &StateCommitment): &vector<u8> {
    &commitment.state_hash
}

/// Get nonce from commitment
public fun state_nonce(commitment: &StateCommitment): u64 {
    commitment.nonce
}

/// Get timestamp from commitment
public fun state_timestamp(commitment: &StateCommitment): u64 {
    commitment.timestamp
}

/// Get party A balance from commitment
public fun state_party_a_balance(commitment: &StateCommitment): u64 {
    commitment.party_a_balance
}

/// Get party B balance from commitment
public fun state_party_b_balance(commitment: &StateCommitment): u64 {
    commitment.party_b_balance
}

/// Get tunnel creation timestamp
public fun created_at<T>(tunnel: &Tunnel<T>): u64 {
    tunnel.created_at
}

/// Get last activity timestamp
public fun last_activity<T>(tunnel: &Tunnel<T>): u64 {
    tunnel.last_activity
}

/// Get timeout duration
public fun timeout_ms<T>(tunnel: &Tunnel<T>): u64 {
    tunnel.timeout_ms
}

/// Get penalty amount
public fun penalty_amount<T>(tunnel: &Tunnel<T>): u64 {
    tunnel.penalty_amount
}

/// Check if a party can raise a timeout claim
public fun can_claim_timeout<T>(tunnel: &Tunnel<T>, clock: &Clock): bool {
    if (tunnel.timeout_ms == 0) {
        return false
    };

    let now = clock.timestamp_ms();
    now >= tunnel.last_activity + tunnel.timeout_ms
}

/// Check if a referee is assigned to the tunnel
public fun has_referee<T>(tunnel: &Tunnel<T>): bool {
    df::exists(&tunnel.id, RefereeKey {})
}

/// Get the referee address (aborts if no referee assigned)
public fun get_referee<T>(tunnel: &Tunnel<T>): address {
    assert!(df::exists(&tunnel.id, RefereeKey {}), ENotFound);
    *df::borrow(&tunnel.id, RefereeKey {})
}

/// Get the total HTLC-locked amount for a specific party
public fun party_htlc_locked<T>(tunnel: &Tunnel<T>, party: address): u64 {
    get_party_htlc_locked(tunnel, party)
}

/// Get the total number of active HTLCs for a specific party
public fun party_htlc_count<T>(tunnel: &Tunnel<T>, party: address): u64 {
    let key = HTLCPartyCounterKey { party };
    if (df::exists(&tunnel.id, key)) {
        let counter: &HTLCPartyCounter = df::borrow(&tunnel.id, key);
        counter.count
    } else {
        0
    }
}

/// Check if a specific HTLC exists in the tunnel
public fun has_htlc<T>(tunnel: &Tunnel<T>, payment_hash: vector<u8>): bool {
    df::exists(&tunnel.id, HTLCKey { payment_hash })
}

// ============================================
// HELPER FUNCTIONS FOR TESTING
// ============================================

// Reserved for future scenario tests
// #[test_only]
// use sui::test_scenario;

#[test_only]
public fun destroy_for_testing<T>(tunnel: Tunnel<T>) {
    let Tunnel { id, balance, .. } = tunnel;

    id.delete();
    balance.destroy_for_testing();
}

/// Get the dispute raiser address
public fun dispute_raiser<T>(tunnel: &Tunnel<T>): Option<address> {
    tunnel.dispute_raiser
}

#[test_only]
public fun create_settlement_data_for_testing(
    tunnel_id: ID,
    party_a_balance: u64,
    party_b_balance: u64,
    final_nonce: u64,
    timestamp: u64,
): SettlementData {
    SettlementData { tunnel_id, party_a_balance, party_b_balance, final_nonce, timestamp }
}

#[test_only]
public fun create_settlement_with_root_data_for_testing(
    tunnel_id: ID,
    party_a_balance: u64,
    party_b_balance: u64,
    final_nonce: u64,
    timestamp: u64,
    transcript_root: vector<u8>,
): SettlementWithRootData {
    SettlementWithRootData {
        tunnel_id,
        party_a_balance,
        party_b_balance,
        final_nonce,
        timestamp,
        transcript_root,
    }
}

#[test_only]
public fun create_state_update_data_for_testing(
    tunnel_id: ID,
    state_hash: vector<u8>,
    nonce: u64,
    timestamp: u64,
    party_a_balance: u64,
    party_b_balance: u64,
): StateUpdateData {
    StateUpdateData { tunnel_id, state_hash, nonce, timestamp, party_a_balance, party_b_balance }
}

#[test_only]
public fun create_party_config_for_testing(
    address: address,
    public_key: vector<u8>,
    signature_type: u8,
): PartyConfig {
    PartyConfig { address, public_key, signature_type }
}

#[test_only]
public fun create_state_commitment_for_testing(
    state_hash: vector<u8>,
    nonce: u64,
    timestamp: u64,
    party_a_balance: u64,
    party_b_balance: u64,
): StateCommitment {
    StateCommitment { state_hash, nonce, timestamp, party_a_balance, party_b_balance }
}

#[test_only]
public fun create_htlc_lock_data_for_testing(
    tunnel_id: ID,
    payment_hash: vector<u8>,
    amount: u64,
    sender: address,
    receiver: address,
    expiry_ms: u64,
): HTLCLockData {
    HTLCLockData { tunnel_id, payment_hash, amount, sender, receiver, expiry_ms }
}

#[test_only]
/// Remove referee dynamic field before destroying tunnel in tests
public fun remove_referee_for_testing<T>(tunnel: &mut Tunnel<T>) {
    let key = RefereeKey {};
    if (df::exists(&tunnel.id, key)) {
        let _: address = df::remove(&mut tunnel.id, key);
    };
}

#[test_only]
/// Remove per-party HTLC counter dynamic fields before destroying tunnel in tests
public fun remove_htlc_counters_for_testing<T>(tunnel: &mut Tunnel<T>) {
    let key_a = HTLCPartyCounterKey { party: tunnel.party_a.address };
    if (df::exists(&tunnel.id, key_a)) {
        let _: HTLCPartyCounter = df::remove(&mut tunnel.id, key_a);
    };
    let key_b = HTLCPartyCounterKey { party: tunnel.party_b.address };
    if (df::exists(&tunnel.id, key_b)) {
        let _: HTLCPartyCounter = df::remove(&mut tunnel.id, key_b);
    };
}

#[test_only]
/// Build an already-active tunnel with the given deposits, bypassing the
/// two-party deposit flow (which is sender-gated to each party). The combined
/// balance is minted for testing and the state balances seeded to the deposits.
public fun create_active_for_testing<T>(
    party_a: address,
    party_b: address,
    deposit_a: u64,
    deposit_b: u64,
    timeout_ms: u64,
    penalty_amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Tunnel<T> {
    let pk_a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let pk_b = x"2222222222222222222222222222222222222222222222222222222222222222";
    let mut tunnel = create<T>(
        party_a,
        pk_a,
        signature::ed25519(),
        party_b,
        pk_b,
        signature::ed25519(),
        timeout_ms,
        penalty_amount,
        clock,
        ctx,
    );
    tunnel.party_a_deposit = deposit_a;
    tunnel.party_b_deposit = deposit_b;
    tunnel.balance.join(balance::create_for_testing<T>(deposit_a + deposit_b));
    tunnel.status = STATUS_ACTIVE;
    tunnel.state.party_a_balance = deposit_a;
    tunnel.state.party_b_balance = deposit_b;
    tunnel
}

#[test_only]
/// Lock an HTLC without verifying the counterparty signature, exercising the
/// real on-chain HTLC accounting (`lock_htlc_internal`) so balance-invariant
/// regressions are caught. `ctx.sender()` must be one of the tunnel parties.
public fun lock_htlc_no_sig_for_testing<T>(
    tunnel: &mut Tunnel<T>,
    payment_hash: vector<u8>,
    amount: u64,
    receiver: address,
    expiry_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(tunnel.status == STATUS_ACTIVE, EInvalidState);
    assert!(amount > 0, EInvalidParameter);
    assert!(payment_hash.length() == 32, EInvalidHash);
    let now = clock.timestamp_ms();
    assert!(expiry_ms > now, EInvalidTimeout);
    let sender = ctx.sender();
    let is_party_a = if (sender == tunnel.party_a.address) {
        true
    } else if (sender == tunnel.party_b.address) {
        false
    } else {
        abort ENotAuthorized
    };
    lock_htlc_internal(tunnel, payment_hash, amount, sender, receiver, expiry_ms, is_party_a, now);
}

#[test_only]
/// Attach a referee to an already-active tunnel for testing (the public
/// `set_referee` requires STATUS_CREATED).
public fun set_referee_for_testing<T>(tunnel: &mut Tunnel<T>, referee: address) {
    let key = RefereeKey {};
    if (df::exists(&tunnel.id, key)) {
        *df::borrow_mut<RefereeKey, address>(&mut tunnel.id, key) = referee;
    } else {
        df::add(&mut tunnel.id, key, referee);
    };
}
