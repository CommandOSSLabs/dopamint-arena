/// Module: referee
///
/// Dispute resolution and timeout management for the Sui Tunnel Framework.
/// The referee module provides configurable rules for handling uncooperative
/// parties and enforcing fair outcomes.
///
/// ## Referee Types
///
/// 1. **Automated**: Rules-based, fully on-chain
/// 2. **Designated**: Trusted third-party arbiter
/// 3. **Committee**: Multi-signature decision making
///
/// ## Timeout Model
///
/// ```
/// Action Request ──► Timeout Period ──► Penalty Eligible
///      │                                      │
///      │          Response                    │
///      └──────────────────────────────────────┘
///                     OK
/// ```
///
/// ## Penalty System
///
/// Supports graduated penalties based on:
/// - Violation severity
/// - Response delay
/// - Repeat offenses
///
/// ## Usage Example
///
/// ```move
/// use sui_tunnel::referee;
///
/// // Create referee config
/// let config = referee::create_config(
///     3600000,  // 1 hour timeout
///     1000,     // base penalty
///     500,      // penalty per hour
///     10000,    // max penalty
/// );
///
/// // Check if timeout reached
/// if (referee::is_timeout_reached(&config, last_activity, clock)) {
///     let penalty = referee::calculate_penalty(&config, last_activity, clock);
///     // Apply penalty...
/// }
/// ```
module sui_tunnel::referee;

use sui::clock::Clock;
use sui::event;
use sui::vec_set;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const ENoActiveDispute: vector<u8> = b"There is no active dispute to act on.";

#[error]
const ETimeoutNotReached: vector<u8> = b"The timeout has not been reached yet.";

// ============================================
// CONSTANTS
// ============================================

/// Referee type: Automated (rules-based)
const REFEREE_TYPE_AUTOMATED: u8 = 0;

/// Referee type: Designated arbiter
const REFEREE_TYPE_DESIGNATED: u8 = 1;

/// Referee type: Committee (multi-sig)
const REFEREE_TYPE_COMMITTEE: u8 = 2;

/// Dispute status: No active dispute
const DISPUTE_STATUS_NONE: u8 = 0;

/// Dispute status: Dispute raised, waiting for response
const DISPUTE_STATUS_RAISED: u8 = 1;

/// Dispute status: Evidence submitted, under review
const DISPUTE_STATUS_UNDER_REVIEW: u8 = 2;

/// Dispute status: Resolved in favor of party A
const DISPUTE_STATUS_RESOLVED_A: u8 = 3;

/// Dispute status: Resolved in favor of party B
const DISPUTE_STATUS_RESOLVED_B: u8 = 4;

/// Dispute status: Resolved with split
const DISPUTE_STATUS_RESOLVED_SPLIT: u8 = 5;

/// Dispute status: Timed out (auto-resolved)
const DISPUTE_STATUS_TIMED_OUT: u8 = 6;

/// Violation type: No response to action request
const VIOLATION_NO_RESPONSE: u8 = 0;

/// Violation type: Invalid state submission
const VIOLATION_INVALID_STATE: u8 = 1;

/// Violation type: Attempted double-spend
const VIOLATION_DOUBLE_SPEND: u8 = 2;

/// Violation type: Signature forgery attempt
const VIOLATION_FORGERY: u8 = 3;

/// One hour in milliseconds
const ONE_HOUR_MS: u64 = 3600000;

// ============================================
// STRUCTS
// ============================================

/// Configuration for timeout and penalty rules
public struct RefereeConfig has copy, drop, store {
    /// Type of referee (automated, designated, committee)
    referee_type: u8,
    /// Base timeout duration in milliseconds
    timeout_ms: u64,
    /// Grace period before penalties apply (ms)
    grace_period_ms: u64,
    /// Base penalty amount
    base_penalty: u64,
    /// Additional penalty per time unit after timeout
    penalty_per_hour: u64,
    /// Maximum penalty cap
    max_penalty: u64,
    /// Whether penalties are enabled
    penalties_enabled: bool,
    /// Minimum response time required (for anti-spam)
    min_response_time_ms: u64,
}

/// Represents an active dispute
public struct Dispute has copy, drop, store {
    /// Unique identifier for the dispute
    id: u64,
    /// Who raised the dispute
    raised_by: address,
    /// Who the dispute is against
    against: address,
    /// Type of violation claimed
    violation_type: u8,
    /// Current status
    status: u8,
    /// Evidence hash (off-chain reference)
    evidence_hash: vector<u8>,
    /// State nonce at time of dispute
    state_nonce: u64,
    /// When the dispute was raised
    raised_at: u64,
    /// Deadline for response
    response_deadline: u64,
    /// When the dispute was resolved (0 if not resolved)
    resolved_at: u64,
    /// Resolution details (e.g., penalty amounts)
    resolution: Resolution,
}

/// Resolution details for a dispute
public struct Resolution has copy, drop, store {
    /// Amount awarded to party A
    party_a_amount: u64,
    /// Amount awarded to party B
    party_b_amount: u64,
    /// Penalty amount deducted
    penalty_deducted: u64,
    /// Reason code for resolution
    reason: u8,
}

/// Tracks a party's dispute history
public struct DisputeHistory has copy, drop, store {
    /// Total disputes raised by this party
    disputes_raised: u64,
    /// Total disputes against this party
    disputes_against: u64,
    /// Disputes won
    disputes_won: u64,
    /// Disputes lost
    disputes_lost: u64,
    /// Total penalties paid
    total_penalties_paid: u64,
    /// Consecutive timeouts (resets on good behavior)
    consecutive_timeouts: u64,
}

/// Committee member for multi-sig referee
public struct CommitteeMember has copy, drop, store {
    /// Member's address
    address: address,
    /// Member's voting weight
    weight: u64,
    /// Whether member is active
    active: bool,
}

/// Committee configuration for multi-sig referee
public struct Committee has drop, store {
    /// List of committee members
    members: vector<CommitteeMember>,
    /// Required vote weight for decision
    threshold: u64,
    /// Total active voting weight
    total_weight: u64,
}

/// A vote on a dispute
public struct Vote has copy, drop, store {
    /// Voter's address
    voter: address,
    /// In favor of which party (true = party A, false = party B)
    in_favor_of_a: bool,
    /// Suggested penalty
    suggested_penalty: u64,
    /// Vote timestamp
    timestamp: u64,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a dispute is created
public struct DisputeCreated has copy, drop {
    id: u64,
    raised_by: address,
    against: address,
    violation_type: u8,
}

/// Emitted when a dispute is resolved
public struct DisputeResolved has copy, drop {
    id: u64,
    status: u8,
    party_a_amount: u64,
    party_b_amount: u64,
    penalty_deducted: u64,
}

/// Emitted when a dispute auto-resolves due to timeout
public struct DisputeAutoResolved has copy, drop {
    id: u64,
    awarded_to: address,
    amount: u64,
    penalty: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS FOR CONSTANTS
// ============================================

public fun referee_type_automated(): u8 { REFEREE_TYPE_AUTOMATED }

public fun referee_type_designated(): u8 { REFEREE_TYPE_DESIGNATED }

public fun referee_type_committee(): u8 { REFEREE_TYPE_COMMITTEE }

public fun dispute_status_none(): u8 { DISPUTE_STATUS_NONE }

public fun dispute_status_raised(): u8 { DISPUTE_STATUS_RAISED }

public fun dispute_status_under_review(): u8 { DISPUTE_STATUS_UNDER_REVIEW }

public fun dispute_status_resolved_a(): u8 { DISPUTE_STATUS_RESOLVED_A }

public fun dispute_status_resolved_b(): u8 { DISPUTE_STATUS_RESOLVED_B }

public fun dispute_status_resolved_split(): u8 { DISPUTE_STATUS_RESOLVED_SPLIT }

public fun dispute_status_timed_out(): u8 { DISPUTE_STATUS_TIMED_OUT }

public fun violation_no_response(): u8 { VIOLATION_NO_RESPONSE }

public fun violation_invalid_state(): u8 { VIOLATION_INVALID_STATE }

public fun violation_double_spend(): u8 { VIOLATION_DOUBLE_SPEND }

public fun violation_forgery(): u8 { VIOLATION_FORGERY }

// ============================================
// CONFIGURATION FUNCTIONS
// ============================================

/// Creates a new referee configuration with default values
public fun default_config(): RefereeConfig {
    RefereeConfig {
        referee_type: REFEREE_TYPE_AUTOMATED,
        timeout_ms: ONE_HOUR_MS,
        grace_period_ms: 0,
        base_penalty: 0,
        penalty_per_hour: 0,
        max_penalty: 0,
        penalties_enabled: false,
        min_response_time_ms: 0,
    }
}

/// Creates a custom referee configuration
public fun create_config(
    referee_type: u8,
    timeout_ms: u64,
    grace_period_ms: u64,
    base_penalty: u64,
    penalty_per_hour: u64,
    max_penalty: u64,
    penalties_enabled: bool,
    min_response_time_ms: u64,
): RefereeConfig {
    assert!(referee_type <= REFEREE_TYPE_COMMITTEE, EInvalidParameter);
    assert!(timeout_ms > 0, EInvalidParameter);
    assert!(max_penalty >= base_penalty, EInvalidParameter);

    RefereeConfig {
        referee_type,
        timeout_ms,
        grace_period_ms,
        base_penalty,
        penalty_per_hour,
        max_penalty,
        penalties_enabled,
        min_response_time_ms,
    }
}

/// Validates that a timeout duration is non-zero.
/// Shared by the config constructors so a degenerate zero-timeout config
/// cannot be built via any entry point.
fun assert_valid_timeout(timeout_ms: u64) {
    assert!(timeout_ms > 0, EInvalidParameter);
}

/// Creates a simple timeout-only config (no penalties)
public fun create_timeout_config(timeout_ms: u64): RefereeConfig {
    assert_valid_timeout(timeout_ms);
    RefereeConfig {
        referee_type: REFEREE_TYPE_AUTOMATED,
        timeout_ms,
        grace_period_ms: 0,
        base_penalty: 0,
        penalty_per_hour: 0,
        max_penalty: 0,
        penalties_enabled: false,
        min_response_time_ms: 0,
    }
}

/// Creates a config with penalties enabled
public fun create_penalty_config(
    timeout_ms: u64,
    base_penalty: u64,
    penalty_per_hour: u64,
    max_penalty: u64,
): RefereeConfig {
    assert_valid_timeout(timeout_ms);
    assert!(max_penalty >= base_penalty, EInvalidParameter);

    RefereeConfig {
        referee_type: REFEREE_TYPE_AUTOMATED,
        timeout_ms,
        grace_period_ms: 0,
        base_penalty,
        penalty_per_hour,
        max_penalty,
        penalties_enabled: true,
        min_response_time_ms: 0,
    }
}

// ============================================
// TIMEOUT FUNCTIONS
// ============================================

/// Checks if the timeout period has been reached
public fun is_timeout_reached(config: &RefereeConfig, last_activity: u64, clock: &Clock): bool {
    let now = clock.timestamp_ms();
    // Widen to u128 so the deadline sum cannot overflow u64 and abort.
    let deadline = (last_activity as u128) + (config.timeout_ms as u128);
    (now as u128) >= deadline
}

/// Checks if the timeout period has been reached (with grace period)
public fun is_timeout_with_grace_reached(
    config: &RefereeConfig,
    last_activity: u64,
    clock: &Clock,
): bool {
    let now = clock.timestamp_ms();
    // Widen to u128 so the deadline sum cannot overflow u64 and abort.
    let deadline =
        (last_activity as u128) + (config.timeout_ms as u128) + (config.grace_period_ms as u128);
    (now as u128) >= deadline
}

/// Gets the time remaining until timeout (0 if already timed out)
public fun time_until_timeout(config: &RefereeConfig, last_activity: u64, clock: &Clock): u64 {
    let now = clock.timestamp_ms();
    // Widen to u128 so the deadline sum cannot overflow u64 and abort.
    let deadline = (last_activity as u128) + (config.timeout_ms as u128);
    let now_wide = now as u128;

    if (now_wide >= deadline) {
        0
    } else {
        // Difference fits in u64 because now <= deadline and now is a u64.
        ((deadline - now_wide) as u64)
    }
}

/// Gets the time elapsed since timeout (0 if not yet timed out)
public fun time_since_timeout(config: &RefereeConfig, last_activity: u64, clock: &Clock): u64 {
    let now = clock.timestamp_ms();
    // Widen to u128 so the deadline sum cannot overflow u64 and abort.
    let deadline = (last_activity as u128) + (config.timeout_ms as u128);
    let now_wide = now as u128;

    if (now_wide <= deadline) {
        0
    } else {
        // Difference fits in u64 because it is bounded by now, a u64.
        ((now_wide - deadline) as u64)
    }
}

/// Checks if a response is too fast (anti-spam)
public fun is_response_too_fast(config: &RefereeConfig, request_time: u64, clock: &Clock): bool {
    if (config.min_response_time_ms == 0) {
        return false
    };

    let now = clock.timestamp_ms();
    // Guard against underflow: a response that appears at or before the
    // request time is certainly "too fast".
    if (now <= request_time) {
        return true
    };

    let elapsed = now - request_time;
    elapsed < config.min_response_time_ms
}

// ============================================
// PENALTY FUNCTIONS
// ============================================

/// Calculates the penalty amount based on time elapsed
public fun calculate_penalty(config: &RefereeConfig, last_activity: u64, clock: &Clock): u64 {
    if (!config.penalties_enabled) {
        return 0
    };

    let elapsed = time_since_timeout(config, last_activity, clock);
    if (elapsed == 0) {
        return 0
    };

    // Start with base penalty
    let mut penalty = config.base_penalty;

    // Add time-based penalty
    if (config.penalty_per_hour > 0) {
        let hours_elapsed = elapsed / ONE_HOUR_MS;
        let time_penalty = ((hours_elapsed as u128) * (config.penalty_per_hour as u128) as u64);
        penalty = penalty + time_penalty;
    };

    // Cap at max penalty
    if (penalty > config.max_penalty) {
        config.max_penalty
    } else {
        penalty
    }
}

/// Calculates graduated penalty based on violation history
public fun calculate_graduated_penalty(
    config: &RefereeConfig,
    history: &DisputeHistory,
    last_activity: u64,
    clock: &Clock,
): u64 {
    let base = calculate_penalty(config, last_activity, clock);

    // Multiply by consecutive timeouts (minimum 1x)
    let multiplier = if (history.consecutive_timeouts > 0) {
        history.consecutive_timeouts + 1
    } else {
        1
    };

    let graduated = ((base as u128) * (multiplier as u128) as u64);

    // Still cap at max
    if (graduated > config.max_penalty) {
        config.max_penalty
    } else {
        graduated
    }
}

/// Checks if penalty would exceed available deposit
public fun would_exceed_deposit(penalty: u64, deposit: u64): bool {
    penalty > deposit
}

/// Calculates safe penalty (capped at deposit)
public fun safe_penalty(penalty: u64, deposit: u64): u64 {
    if (penalty > deposit) {
        deposit
    } else {
        penalty
    }
}

// ============================================
// DISPUTE FUNCTIONS
// ============================================

/// Creates a new dispute.
/// The dispute raiser is derived from `ctx.sender()` to prevent impersonation.
public fun create_dispute(
    id: u64,
    against: address,
    violation_type: u8,
    evidence_hash: vector<u8>,
    state_nonce: u64,
    config: &RefereeConfig,
    clock: &Clock,
    ctx: &TxContext,
): Dispute {
    let raised_by = ctx.sender();
    let now = clock.timestamp_ms();

    // Compute the deadline in u128 and saturate to u64 max so the sum
    // cannot overflow the u64 `response_deadline` field and abort.
    let deadline_wide = (now as u128) + (config.timeout_ms as u128);
    let response_deadline = if (deadline_wide > (std::u64::max_value!() as u128)) {
        std::u64::max_value!()
    } else {
        (deadline_wide as u64)
    };

    event::emit(DisputeCreated { id, raised_by, against, violation_type });

    Dispute {
        id,
        raised_by,
        against,
        violation_type,
        status: DISPUTE_STATUS_RAISED,
        evidence_hash,
        state_nonce,
        raised_at: now,
        response_deadline,
        resolved_at: 0,
        resolution: empty_resolution(),
    }
}

/// Creates an empty resolution
public fun empty_resolution(): Resolution {
    Resolution {
        party_a_amount: 0,
        party_b_amount: 0,
        penalty_deducted: 0,
        reason: 0,
    }
}

/// Creates a resolution with specified amounts
public fun create_resolution(
    party_a_amount: u64,
    party_b_amount: u64,
    penalty_deducted: u64,
    reason: u8,
): Resolution {
    Resolution {
        party_a_amount,
        party_b_amount,
        penalty_deducted,
        reason,
    }
}

/// Checks if dispute can be auto-resolved due to timeout
public fun can_auto_resolve(dispute: &Dispute, clock: &Clock): bool {
    if (dispute.status != DISPUTE_STATUS_RAISED) {
        return false
    };

    let now = clock.timestamp_ms();
    now >= dispute.response_deadline
}

/// Returns whether the dispute is in a resolvable state (raised or under review).
public fun can_resolve(dispute: &Dispute): bool {
    dispute.status == DISPUTE_STATUS_RAISED || dispute.status == DISPUTE_STATUS_UNDER_REVIEW
}

/// Resolves a dispute in favor of party A.
/// Caller must ensure the dispute is in an active state before resolving.
public fun resolve_for_a(
    dispute: &mut Dispute,
    party_a_amount: u64,
    party_b_amount: u64,
    penalty: u64,
    clock: &Clock,
) {
    assert!(can_resolve(dispute), ENoActiveDispute);
    dispute.status = DISPUTE_STATUS_RESOLVED_A;
    dispute.resolved_at = clock.timestamp_ms();
    dispute.resolution = create_resolution(party_a_amount, party_b_amount, penalty, 1);
    event::emit(DisputeResolved {
        id: dispute.id,
        status: DISPUTE_STATUS_RESOLVED_A,
        party_a_amount,
        party_b_amount,
        penalty_deducted: penalty,
    });
}

/// Resolves a dispute in favor of party B.
/// Caller must ensure the dispute is in an active state before resolving.
public fun resolve_for_b(
    dispute: &mut Dispute,
    party_a_amount: u64,
    party_b_amount: u64,
    penalty: u64,
    clock: &Clock,
) {
    assert!(can_resolve(dispute), ENoActiveDispute);
    dispute.status = DISPUTE_STATUS_RESOLVED_B;
    dispute.resolved_at = clock.timestamp_ms();
    dispute.resolution = create_resolution(party_a_amount, party_b_amount, penalty, 2);
    event::emit(DisputeResolved {
        id: dispute.id,
        status: DISPUTE_STATUS_RESOLVED_B,
        party_a_amount,
        party_b_amount,
        penalty_deducted: penalty,
    });
}

/// Resolves a dispute with a split.
/// Caller must ensure the dispute is in an active state before resolving.
public fun resolve_split(
    dispute: &mut Dispute,
    party_a_amount: u64,
    party_b_amount: u64,
    penalty: u64,
    clock: &Clock,
) {
    assert!(can_resolve(dispute), ENoActiveDispute);
    dispute.status = DISPUTE_STATUS_RESOLVED_SPLIT;
    dispute.resolved_at = clock.timestamp_ms();
    dispute.resolution = create_resolution(party_a_amount, party_b_amount, penalty, 3);
    event::emit(DisputeResolved {
        id: dispute.id,
        status: DISPUTE_STATUS_RESOLVED_SPLIT,
        party_a_amount,
        party_b_amount,
        penalty_deducted: penalty,
    });
}

/// Auto-resolve due to timeout (in favor of the party who raised).
/// `party_a` identifies which address maps to `party_a_amount` in the
/// resolution so that funds are attributed to the correct side.
public fun auto_resolve_timeout(
    dispute: &mut Dispute,
    total_balance: u64,
    penalty: u64,
    party_a: address,
    clock: &Clock,
) {
    assert!(can_auto_resolve(dispute, clock), ETimeoutNotReached);

    dispute.status = DISPUTE_STATUS_TIMED_OUT;
    dispute.resolved_at = clock.timestamp_ms();

    // Award full balance minus penalty to the party who raised
    // (penalty comes from the unresponsive party)
    let safe_pen = safe_penalty(penalty, total_balance);
    let awarded = total_balance - safe_pen;

    // Correctly assign awarded amount based on whether raiser is party_a or party_b
    let (a_amount, b_amount) = if (dispute.raised_by == party_a) {
        (awarded, 0u64)
    } else {
        (0u64, awarded)
    };

    dispute.resolution =
        create_resolution(
            a_amount,
            b_amount,
            safe_pen,
            4, // Reason: timeout
        );

    event::emit(DisputeAutoResolved {
        id: dispute.id,
        awarded_to: dispute.raised_by,
        amount: awarded,
        penalty: safe_pen,
    });
}

// ============================================
// DISPUTE HISTORY FUNCTIONS
// ============================================

/// Creates a new empty dispute history
public fun new_dispute_history(): DisputeHistory {
    DisputeHistory {
        disputes_raised: 0,
        disputes_against: 0,
        disputes_won: 0,
        disputes_lost: 0,
        total_penalties_paid: 0,
        consecutive_timeouts: 0,
    }
}

/// Records that a party raised a dispute
public fun record_dispute_raised(history: &mut DisputeHistory) {
    history.disputes_raised = history.disputes_raised + 1;
}

/// Records that a dispute was raised against a party
public fun record_dispute_against(history: &mut DisputeHistory) {
    history.disputes_against = history.disputes_against + 1;
}

/// Records a dispute win
public fun record_dispute_won(history: &mut DisputeHistory) {
    history.disputes_won = history.disputes_won + 1;
    history.consecutive_timeouts = 0; // Reset on good behavior
}

/// Records a dispute loss
public fun record_dispute_lost(history: &mut DisputeHistory, penalty_paid: u64) {
    history.disputes_lost = history.disputes_lost + 1;
    history.total_penalties_paid = history.total_penalties_paid + penalty_paid;
}

/// Records a timeout (unresponsive behavior)
public fun record_timeout(history: &mut DisputeHistory, penalty_paid: u64) {
    history.disputes_lost = history.disputes_lost + 1;
    history.total_penalties_paid = history.total_penalties_paid + penalty_paid;
    history.consecutive_timeouts = history.consecutive_timeouts + 1;
}

/// Resets consecutive timeouts (good behavior reward)
public fun reset_consecutive_timeouts(history: &mut DisputeHistory) {
    history.consecutive_timeouts = 0;
}

// ============================================
// COMMITTEE FUNCTIONS
// ============================================

/// Creates a new committee
public fun create_committee(threshold: u64): Committee {
    Committee {
        members: vector[],
        threshold,
        total_weight: 0,
    }
}

/// Adds a member to the committee
public fun add_committee_member(committee: &mut Committee, member_address: address, weight: u64) {
    assert!(weight > 0, EInvalidParameter);

    // Reject duplicates: an active member with this address must not already
    // exist, since removal only deactivates the first active match.
    committee.members.do_ref!(|existing| {
        assert!(!(existing.address == member_address && existing.active), EInvalidParameter);
    });

    let member = CommitteeMember {
        address: member_address,
        weight,
        active: true,
    };

    committee.members.push_back(member);
    committee.total_weight = committee.total_weight + weight;
}

/// Removes a member from the committee
public fun remove_committee_member(committee: &mut Committee, member_address: address) {
    let found = committee.members.find_index!(|member| {
        member.address == member_address && member.active
    });
    if (found.is_some()) {
        let member = &mut committee.members[found.destroy_some()];
        member.active = false;
        committee.total_weight = committee.total_weight - member.weight;
    };
}

/// Checks if votes meet the threshold.
/// Validates each voter is an active committee member, uses on-chain weight,
/// and deduplicates votes from the same address.
public fun votes_meet_threshold(
    committee: &Committee,
    votes: &vector<Vote>,
    in_favor_of_a: bool,
): bool {
    let mut total_weight = 0u64;
    let vote_len = votes.length();
    let mut seen_voters = vec_set::empty<address>();
    let mut vi = 0;

    while (vi < vote_len) {
        let vote = &votes[vi];

        if (!seen_voters.contains(&vote.voter) && vote.in_favor_of_a == in_favor_of_a) {
            // Look up the voter in the committee members list
            let member_count = committee.members.length();
            let mut mi = 0;
            while (mi < member_count) {
                let member = &committee.members[mi];
                if (member.address == vote.voter && member.active) {
                    // Use on-chain member weight, not vote-supplied weight
                    total_weight = total_weight + member.weight;
                    seen_voters.insert(vote.voter);
                    break
                };
                mi = mi + 1;
            };
            // Non-member votes are silently ignored
        };

        vi = vi + 1;
    };

    total_weight >= committee.threshold
}

/// Creates a vote. The voter must be the transaction sender to prevent impersonation.
public fun create_vote(
    in_favor_of_a: bool,
    suggested_penalty: u64,
    clock: &Clock,
    ctx: &TxContext,
): Vote {
    Vote {
        voter: ctx.sender(),
        in_favor_of_a,
        suggested_penalty,
        timestamp: clock.timestamp_ms(),
    }
}

// ============================================
// ACCESSOR FUNCTIONS
// ============================================

// Config accessors
public fun config_referee_type(config: &RefereeConfig): u8 { config.referee_type }

public fun config_timeout_ms(config: &RefereeConfig): u64 { config.timeout_ms }

public fun config_grace_period_ms(config: &RefereeConfig): u64 { config.grace_period_ms }

public fun config_base_penalty(config: &RefereeConfig): u64 { config.base_penalty }

public fun config_penalty_per_hour(config: &RefereeConfig): u64 { config.penalty_per_hour }

public fun config_max_penalty(config: &RefereeConfig): u64 { config.max_penalty }

public fun config_penalties_enabled(config: &RefereeConfig): bool { config.penalties_enabled }

// Dispute accessors
public fun dispute_id(dispute: &Dispute): u64 { dispute.id }

public fun dispute_raised_by(dispute: &Dispute): address { dispute.raised_by }

public fun dispute_against(dispute: &Dispute): address { dispute.against }

public fun dispute_violation_type(dispute: &Dispute): u8 { dispute.violation_type }

public fun dispute_status(dispute: &Dispute): u8 { dispute.status }

public fun dispute_evidence_hash(dispute: &Dispute): &vector<u8> { &dispute.evidence_hash }

public fun dispute_state_nonce(dispute: &Dispute): u64 { dispute.state_nonce }

public fun dispute_raised_at(dispute: &Dispute): u64 { dispute.raised_at }

public fun dispute_response_deadline(dispute: &Dispute): u64 { dispute.response_deadline }

public fun dispute_resolved_at(dispute: &Dispute): u64 { dispute.resolved_at }

public fun dispute_resolution(dispute: &Dispute): &Resolution { &dispute.resolution }

// Resolution accessors
public fun resolution_party_a_amount(resolution: &Resolution): u64 { resolution.party_a_amount }

public fun resolution_party_b_amount(resolution: &Resolution): u64 { resolution.party_b_amount }

public fun resolution_penalty_deducted(resolution: &Resolution): u64 { resolution.penalty_deducted }

public fun resolution_reason(resolution: &Resolution): u8 { resolution.reason }

// History accessors
public fun history_disputes_raised(history: &DisputeHistory): u64 { history.disputes_raised }

public fun history_disputes_against(history: &DisputeHistory): u64 { history.disputes_against }

public fun history_disputes_won(history: &DisputeHistory): u64 { history.disputes_won }

public fun history_disputes_lost(history: &DisputeHistory): u64 { history.disputes_lost }

public fun history_total_penalties_paid(history: &DisputeHistory): u64 {
    history.total_penalties_paid
}

public fun history_consecutive_timeouts(history: &DisputeHistory): u64 {
    history.consecutive_timeouts
}

// Committee accessors
public fun committee_threshold(committee: &Committee): u64 { committee.threshold }

public fun committee_total_weight(committee: &Committee): u64 { committee.total_weight }

public fun committee_member_count(committee: &Committee): u64 { committee.members.length() }

// Vote accessors
public fun vote_voter(vote: &Vote): address { vote.voter }

public fun vote_in_favor_of_a(vote: &Vote): bool { vote.in_favor_of_a }

public fun vote_suggested_penalty(vote: &Vote): u64 { vote.suggested_penalty }
