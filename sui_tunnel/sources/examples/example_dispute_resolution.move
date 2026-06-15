/// Example: Dispute Resolution
///
/// Demonstrates the `referee` module for configurable dispute resolution.
/// Shows how to use different service levels, penalty graduation, committee
/// voting, and timeout-based auto-resolution.
///
/// ## Service Levels:
/// - **Basic**: 24h timeout, no penalties
/// - **Standard**: 4h timeout, moderate penalties, grace period
/// - **Premium**: 1h timeout, steep penalties, committee arbitration
///
/// ## Key Patterns:
/// - Creating and configuring referee configs for different use cases
/// - Opening and resolving disputes
/// - Graduated penalties for repeat offenders
/// - Committee-based multi-party voting
module sui_tunnel::example_dispute_resolution;

use sui::clock::Clock;
use sui::event;
use sui_tunnel::referee::{Self, Committee, Dispute, DisputeHistory, RefereeConfig, Vote};

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EEmptyInput: vector<u8> = b"Input is empty where a non-empty value was required.";

// ============================================
// CONSTANTS
// ============================================

/// Service level: Basic (24h timeout, no penalties)
const SERVICE_BASIC: u8 = 0;

/// Service level: Standard (4h timeout, moderate penalties)
const SERVICE_STANDARD: u8 = 1;

/// Service level: Premium (1h timeout, steep penalties, committee)
const SERVICE_PREMIUM: u8 = 2;

/// Case status: Open
const CASE_OPEN: u8 = 0;

/// Case status: Resolved
const CASE_RESOLVED: u8 = 1;

/// Case status: Timed out
const CASE_TIMED_OUT: u8 = 2;

/// 24 hours in milliseconds
const TWENTY_FOUR_HOURS_MS: u64 = 86400000;

/// 4 hours in milliseconds
const FOUR_HOURS_MS: u64 = 14400000;

/// 1 hour in milliseconds
const ONE_HOUR_MS: u64 = 3600000;

/// 30 minutes grace period
const GRACE_PERIOD_MS: u64 = 1800000;

// ============================================
// STRUCTS
// ============================================

/// Wraps a referee dispute with application-level metadata.
public struct DisputeCase has key, store {
    id: UID,
    /// The underlying referee dispute
    dispute: Dispute,
    /// The referee config used
    config: RefereeConfig,
    /// Service level of the case
    service_level: u8,
    /// Case status
    status: u8,
    /// Description of the dispute
    description: vector<u8>,
    /// Dispute history for the party this was raised against
    respondent_history: DisputeHistory,
}

/// Result of an arbitration
public struct ArbitrationResult has copy, drop, store {
    /// Case ID (for tracking)
    case_number: u64,
    /// Winner address (None for split resolution)
    winner: Option<address>,
    /// Amount awarded to party A
    party_a_amount: u64,
    /// Amount awarded to party B
    party_b_amount: u64,
    /// Penalty applied
    penalty_amount: u64,
    /// Resolution method (manual, timeout, committee)
    resolution_method: u8,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a dispute case is opened
public struct CaseOpened has copy, drop {
    case_number: u64,
    raised_by: address,
    against: address,
    service_level: u8,
}

/// Emitted when a case is resolved
public struct CaseResolved has copy, drop {
    case_number: u64,
    resolution_method: u8,
    party_a_amount: u64,
    party_b_amount: u64,
    penalty: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS FOR CONSTANTS
// ============================================

public fun service_basic(): u8 { SERVICE_BASIC }

public fun service_standard(): u8 { SERVICE_STANDARD }

public fun service_premium(): u8 { SERVICE_PREMIUM }

public fun case_open(): u8 { CASE_OPEN }

public fun case_resolved(): u8 { CASE_RESOLVED }

public fun case_timed_out(): u8 { CASE_TIMED_OUT }

// ============================================
// CONFIGURATION FACTORY FUNCTIONS
// ============================================

/// Creates a Basic service config: 24h timeout, no penalties.
/// Good for low-value, non-time-sensitive disputes.
public fun create_basic_config(): RefereeConfig {
    referee::create_timeout_config(TWENTY_FOUR_HOURS_MS)
}

/// Creates a Standard service config: 4h timeout, moderate penalties.
/// Good for medium-value transactions with reasonable urgency.
public fun create_standard_config(): RefereeConfig {
    referee::create_config(
        referee::referee_type_automated(),
        FOUR_HOURS_MS, // 4 hour timeout
        GRACE_PERIOD_MS, // 30 min grace period
        500, // base penalty: 500 units
        200, // 200 per hour after timeout
        5000, // max penalty: 5000 units
        true, // penalties enabled
        0, // no min response time
    )
}

/// Creates a Premium service config: 1h timeout, steep penalties, committee-based.
/// Good for high-value transactions requiring fast resolution.
public fun create_premium_config(): RefereeConfig {
    referee::create_config(
        referee::referee_type_committee(),
        ONE_HOUR_MS, // 1 hour timeout
        0, // no grace period
        2000, // base penalty: 2000 units
        1000, // 1000 per hour after timeout
        20000, // max penalty: 20000 units
        true, // penalties enabled
        0, // no min response time
    )
}

/// Returns the config for a given service level
public fun get_config_for_level(level: u8): RefereeConfig {
    if (level == SERVICE_BASIC) {
        create_basic_config()
    } else if (level == SERVICE_STANDARD) {
        create_standard_config()
    } else if (level == SERVICE_PREMIUM) {
        create_premium_config()
    } else {
        abort EInvalidParameter
    }
}

// ============================================
// DISPUTE CASE FUNCTIONS
// ============================================

/// Opens a new dispute case.
///
/// ## Parameters
/// - `case_number`: Unique identifier for the case
/// - `raised_by`: Address of the party raising the dispute
/// - `against`: Address of the party being disputed
/// - `violation_type`: Type of violation claimed
/// - `evidence_hash`: Hash of off-chain evidence
/// - `state_nonce`: State nonce at time of dispute
/// - `description`: Human-readable description
/// - `service_level`: Which service level to use
/// - `respondent_history`: Dispute history of the respondent
/// - `clock`: Clock for timestamps
/// - `ctx`: Transaction context
public fun open_case(
    case_number: u64,
    against: address,
    violation_type: u8,
    evidence_hash: vector<u8>,
    state_nonce: u64,
    description: vector<u8>,
    service_level: u8,
    respondent_history: DisputeHistory,
    clock: &Clock,
    ctx: &mut TxContext,
): DisputeCase {
    let config = get_config_for_level(service_level);
    let raised_by = ctx.sender();

    let dispute = referee::create_dispute(
        case_number,
        against,
        violation_type,
        evidence_hash,
        state_nonce,
        &config,
        clock,
        ctx,
    );

    event::emit(CaseOpened {
        case_number,
        raised_by,
        against,
        service_level,
    });

    DisputeCase {
        id: object::new(ctx),
        dispute,
        config,
        service_level,
        status: CASE_OPEN,
        description,
        respondent_history,
    }
}

/// Resolves a case in favor of party A (the one who raised it).
public fun resolve_for_raiser(
    case: &mut DisputeCase,
    party_a_amount: u64,
    party_b_amount: u64,
    penalty: u64,
    clock: &Clock,
): ArbitrationResult {
    assert!(case.status == CASE_OPEN, EInvalidState);

    referee::resolve_for_a(
        &mut case.dispute,
        party_a_amount,
        party_b_amount,
        penalty,
        clock,
    );

    case.status = CASE_RESOLVED;

    let case_number = referee::dispute_id(&case.dispute);

    event::emit(CaseResolved {
        case_number,
        resolution_method: 1, // manual
        party_a_amount,
        party_b_amount,
        penalty,
    });

    ArbitrationResult {
        case_number,
        winner: option::some(referee::dispute_raised_by(&case.dispute)),
        party_a_amount,
        party_b_amount,
        penalty_amount: penalty,
        resolution_method: 1,
    }
}

/// Resolves a case in favor of party B (the respondent).
public fun resolve_for_respondent(
    case: &mut DisputeCase,
    party_a_amount: u64,
    party_b_amount: u64,
    penalty: u64,
    clock: &Clock,
): ArbitrationResult {
    assert!(case.status == CASE_OPEN, EInvalidState);

    referee::resolve_for_b(
        &mut case.dispute,
        party_a_amount,
        party_b_amount,
        penalty,
        clock,
    );

    case.status = CASE_RESOLVED;

    let case_number = referee::dispute_id(&case.dispute);

    event::emit(CaseResolved {
        case_number,
        resolution_method: 2, // manual for respondent
        party_a_amount,
        party_b_amount,
        penalty,
    });

    ArbitrationResult {
        case_number,
        winner: option::some(referee::dispute_against(&case.dispute)),
        party_a_amount,
        party_b_amount,
        penalty_amount: penalty,
        resolution_method: 2,
    }
}

/// Resolves a case with a split between both parties.
public fun resolve_split(
    case: &mut DisputeCase,
    party_a_amount: u64,
    party_b_amount: u64,
    penalty: u64,
    clock: &Clock,
): ArbitrationResult {
    assert!(case.status == CASE_OPEN, EInvalidState);

    referee::resolve_split(
        &mut case.dispute,
        party_a_amount,
        party_b_amount,
        penalty,
        clock,
    );

    case.status = CASE_RESOLVED;

    let case_number = referee::dispute_id(&case.dispute);

    event::emit(CaseResolved {
        case_number,
        resolution_method: 3, // split
        party_a_amount,
        party_b_amount,
        penalty,
    });

    ArbitrationResult {
        case_number,
        winner: option::none(), // no single winner in split
        party_a_amount,
        party_b_amount,
        penalty_amount: penalty,
        resolution_method: 3,
    }
}

/// Auto-resolves a case after timeout. The raiser wins by default.
/// `party_a` identifies which address maps to `party_a_amount` in the
/// resolution so that funds are attributed to the correct side.
public fun auto_resolve_timeout(
    case: &mut DisputeCase,
    total_balance: u64,
    party_a: address,
    clock: &Clock,
): ArbitrationResult {
    assert!(case.status == CASE_OPEN, EInvalidState);

    // Calculate graduated penalty based on respondent's history
    let penalty = referee::calculate_graduated_penalty(
        &case.config,
        &case.respondent_history,
        referee::dispute_raised_at(&case.dispute),
        clock,
    );

    referee::auto_resolve_timeout(
        &mut case.dispute,
        total_balance,
        penalty,
        party_a,
        clock,
    );

    case.status = CASE_TIMED_OUT;

    // Update respondent history
    referee::record_timeout(&mut case.respondent_history, penalty);

    let case_number = referee::dispute_id(&case.dispute);
    let resolution = referee::dispute_resolution(&case.dispute);
    let party_a_amount = referee::resolution_party_a_amount(resolution);
    let party_b_amount = referee::resolution_party_b_amount(resolution);
    let penalty_deducted = referee::resolution_penalty_deducted(resolution);

    event::emit(CaseResolved {
        case_number,
        resolution_method: 4, // timeout
        party_a_amount,
        party_b_amount,
        penalty: penalty_deducted,
    });

    ArbitrationResult {
        case_number,
        winner: option::some(referee::dispute_raised_by(&case.dispute)),
        party_a_amount,
        party_b_amount,
        penalty_amount: penalty_deducted,
        resolution_method: 4,
    }
}

/// Calculates the penalty for the respondent based on their history
/// and how long they've been unresponsive.
public fun calculate_penalty(case: &DisputeCase, clock: &Clock): u64 {
    referee::calculate_graduated_penalty(
        &case.config,
        &case.respondent_history,
        referee::dispute_raised_at(&case.dispute),
        clock,
    )
}

// ============================================
// COMMITTEE VOTING FUNCTIONS
// ============================================

/// Creates a committee for premium dispute resolution.
///
/// ## Parameters
/// - `members`: Addresses of committee members
/// - `weights`: Voting weights for each member
/// - `threshold`: Weight needed for a decision
public fun create_arbitration_committee(
    members: vector<address>,
    weights: vector<u64>,
    threshold: u64,
): Committee {
    assert!(members.length() == weights.length(), EInvalidParameter);
    assert!(members.length() > 0, EEmptyInput);

    let mut committee = referee::create_committee(threshold);

    members.length().do!(|i| {
        referee::add_committee_member(
            &mut committee,
            members[i],
            weights[i],
        );
    });

    committee
}

/// Records a committee member's vote on a dispute.
public fun committee_vote(
    in_favor_of_raiser: bool,
    suggested_penalty: u64,
    clock: &Clock,
    ctx: &TxContext,
): Vote {
    referee::create_vote(in_favor_of_raiser, suggested_penalty, clock, ctx)
}

/// Checks if the votes meet the committee threshold for the raiser.
public fun has_quorum_for_raiser(committee: &Committee, votes: &vector<Vote>): bool {
    referee::votes_meet_threshold(committee, votes, true)
}

/// Checks if the votes meet the committee threshold for the respondent.
public fun has_quorum_for_respondent(committee: &Committee, votes: &vector<Vote>): bool {
    referee::votes_meet_threshold(committee, votes, false)
}

// ============================================
// ACCESSOR FUNCTIONS
// ============================================

/// Get the case status
public fun case_status(case: &DisputeCase): u8 {
    case.status
}

/// Get the service level
public fun case_service_level(case: &DisputeCase): u8 {
    case.service_level
}

/// Get the description
public fun case_description(case: &DisputeCase): &vector<u8> {
    &case.description
}

/// Get the underlying dispute
public fun case_dispute(case: &DisputeCase): &Dispute {
    &case.dispute
}

/// Get the referee config
public fun case_config(case: &DisputeCase): &RefereeConfig {
    &case.config
}

/// Get the respondent's dispute history
public fun case_respondent_history(case: &DisputeCase): &DisputeHistory {
    &case.respondent_history
}

/// Get the dispute deadline
public fun case_deadline(case: &DisputeCase): u64 {
    referee::dispute_response_deadline(&case.dispute)
}

/// Check if the case can be auto-resolved
public fun can_auto_resolve(case: &DisputeCase, clock: &Clock): bool {
    case.status == CASE_OPEN && referee::can_auto_resolve(&case.dispute, clock)
}

/// ArbitrationResult accessors
public fun result_case_number(result: &ArbitrationResult): u64 {
    result.case_number
}

public fun result_winner(result: &ArbitrationResult): Option<address> {
    result.winner
}

public fun result_party_a_amount(result: &ArbitrationResult): u64 {
    result.party_a_amount
}

public fun result_party_b_amount(result: &ArbitrationResult): u64 {
    result.party_b_amount
}

public fun result_penalty_amount(result: &ArbitrationResult): u64 {
    result.penalty_amount
}

public fun result_resolution_method(result: &ArbitrationResult): u8 {
    result.resolution_method
}

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_case_for_testing(case: DisputeCase) {
    let DisputeCase { id, .. } = case;
    id.delete();
}

#[test_only]
public fun create_arbitration_result_for_testing(
    case_number: u64,
    winner: option::Option<address>,
    party_a_amount: u64,
    party_b_amount: u64,
    penalty_amount: u64,
    resolution_method: u8,
): ArbitrationResult {
    ArbitrationResult {
        case_number,
        winner,
        party_a_amount,
        party_b_amount,
        penalty_amount,
        resolution_method,
    }
}
