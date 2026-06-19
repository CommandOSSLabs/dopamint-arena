/// Example: Multi-Party Channel Network
///
/// Composes multiple 2-party tunnels with HTLC routing to create
/// N-party payment networks, similar to the Lightning Network.
/// The core tunnel remains strictly 2-party; this module adds
/// network-level coordination on top.
///
/// ## Architecture
///
/// ```
/// Alice ──tunnel_ab──> Bob ──tunnel_bc──> Carol ──tunnel_cd──> Dave
/// ```
///
/// Each arrow is a separate 2-party tunnel. Payments between any two
/// parties route through intermediaries using HTLCs with cascading
/// timeouts. Disputes in one link are isolated from all others.
///
/// ## Flow
///
/// 1. Create a channel network
/// 2. Register participant nodes
/// 3. Add links (references to existing 2-party tunnels)
/// 4. Route payments between any two parties through intermediaries
/// 5. Settle links independently
/// 6. Close the network
module sui_tunnel::example_multi_party_channel;

use sui::clock::Clock;
use sui::event;
use sui_tunnel::hop;

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
const EMaxParticipantsExceeded: vector<u8> = b"The maximum number of participants has been exceeded.";

#[error]
const EInvalidHop: vector<u8> = b"The hop is invalid.";

#[error]
const EMaxHopsExceeded: vector<u8> = b"The maximum number of hops has been exceeded.";

// ============================================
// CONSTANTS
// ============================================

/// Network status: Open (accepting new links and payments)
const NETWORK_OPEN: u8 = 0;

/// Network status: Settling (no new payments, links settling)
const NETWORK_SETTLING: u8 = 1;

/// Network status: Closed (all links settled)
const NETWORK_CLOSED: u8 = 2;

/// Link status: Active
const LINK_ACTIVE: u8 = 0;

/// Link status: Settling
const LINK_SETTLING: u8 = 1;

/// Link status: Settled
const LINK_SETTLED: u8 = 2;

/// Link status: Disputed
const LINK_DISPUTED: u8 = 3;

/// Routed payment status: Pending
const PAYMENT_PENDING: u8 = 0;

/// Routed payment status: Completed
const PAYMENT_COMPLETED: u8 = 1;

/// Routed payment status: Failed
const PAYMENT_FAILED: u8 = 2;

/// Maximum participants in a network
const MAX_PARTICIPANTS: u64 = 20;

/// Maximum links in a network
const MAX_LINKS: u64 = 100;

/// Default hop timeout delta: 2 minutes
const DEFAULT_HOP_TIMEOUT_MS: u64 = 120000;

// ============================================
// STRUCTS
// ============================================

/// A participant node in the channel network
public struct Participant has copy, drop, store {
    /// Participant address
    address: address,
    /// Routing node data (fee policy, statistics)
    routing_node: hop::RoutingNode,
    /// Index in participant list
    index: u64,
}

/// A link between two participants (references an external 2-party tunnel)
public struct ChannelLink has copy, drop, store {
    /// Tunnel ID (reference to external Tunnel<T> object)
    tunnel_id: vector<u8>,
    /// Party A address (in the underlying tunnel)
    party_a: address,
    /// Party B address (in the underlying tunnel)
    party_b: address,
    /// Capacity from A to B (based on A's balance in tunnel)
    capacity_a_to_b: u64,
    /// Capacity from B to A (based on B's balance in tunnel)
    capacity_b_to_a: u64,
    /// Link status
    status: u8,
    /// Total routed through this link
    total_routed: u64,
    /// Link index
    index: u64,
}

/// A routed payment across the network
public struct RoutedPayment has key, store {
    id: UID,
    /// Payment route (from hop module)
    route: hop::Route,
    /// Payment hash
    payment_hash: vector<u8>,
    /// Preimage (set on completion)
    preimage: vector<u8>,
    /// Amount
    amount: u64,
    /// Total fees
    total_fees: u64,
    /// HTLCs for each hop
    htlcs: vector<hop::HTLC>,
    /// Number of settled HTLCs
    settled_count: u64,
    /// Status
    status: u8,
    /// Source participant address
    source: address,
    /// Destination participant address
    destination: address,
}

/// The multi-party channel network
public struct ChannelNetwork has key, store {
    id: UID,
    /// Network creator/coordinator
    coordinator: address,
    /// List of participants
    participants: vector<Participant>,
    /// List of links between participants
    links: vector<ChannelLink>,
    /// Network status
    status: u8,
    /// Total payments routed
    total_payments: u64,
    /// Total volume routed
    total_volume: u64,
    /// Network creation timestamp
    created_at: u64,
}

/// Settlement summary for a closed link
public struct LinkSettlement has copy, drop, store {
    /// Tunnel ID of the settled link
    tunnel_id: vector<u8>,
    /// Final balance for party A
    party_a_final: u64,
    /// Final balance for party B
    party_b_final: u64,
    /// Total routed through link
    total_routed: u64,
}

/// Receipt for a completed network payment
public struct NetworkPaymentReceipt has copy, drop, store {
    /// Payment route ID
    route_id: vector<u8>,
    /// Source address
    source: address,
    /// Destination address
    destination: address,
    /// Amount delivered
    amount: u64,
    /// Fees paid
    fees: u64,
    /// Number of hops traversed
    hop_count: u64,
    /// Completion timestamp
    completed_at: u64,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a network is created
public struct NetworkCreated has copy, drop {
    coordinator: address,
    created_at: u64,
}

/// Emitted when a participant joins
public struct ParticipantRegistered has copy, drop {
    address: address,
    participant_count: u64,
}

/// Emitted when a link is added
public struct LinkAdded has copy, drop {
    party_a: address,
    party_b: address,
    tunnel_id: vector<u8>,
}

/// Emitted when a payment is routed
public struct PaymentRouted has copy, drop {
    source: address,
    destination: address,
    amount: u64,
    hop_count: u64,
}

/// Emitted when a payment completes
public struct PaymentSettled has copy, drop {
    source: address,
    destination: address,
    amount: u64,
    fees: u64,
}

/// Emitted when a link is settled
public struct LinkSettledEvent has copy, drop {
    tunnel_id: vector<u8>,
    party_a: address,
    party_b: address,
}

/// Emitted when a link enters dispute
public struct LinkDisputed has copy, drop {
    tunnel_id: vector<u8>,
    party_a: address,
    party_b: address,
}

/// Emitted when the network is closed
public struct NetworkClosed has copy, drop {
    coordinator: address,
    total_payments: u64,
    total_volume: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS FOR CONSTANTS
// ============================================

public fun network_open(): u8 { NETWORK_OPEN }

public fun network_settling(): u8 { NETWORK_SETTLING }

public fun network_closed(): u8 { NETWORK_CLOSED }

public fun link_active(): u8 { LINK_ACTIVE }

public fun link_settling(): u8 { LINK_SETTLING }

public fun link_settled(): u8 { LINK_SETTLED }

public fun link_disputed(): u8 { LINK_DISPUTED }

public fun payment_pending(): u8 { PAYMENT_PENDING }

public fun payment_completed(): u8 { PAYMENT_COMPLETED }

public fun payment_failed(): u8 { PAYMENT_FAILED }

public fun max_participants(): u64 { MAX_PARTICIPANTS }

public fun max_links(): u64 { MAX_LINKS }

public fun default_hop_timeout_ms(): u64 { DEFAULT_HOP_TIMEOUT_MS }

// ============================================
// NETWORK LIFECYCLE FUNCTIONS
// ============================================

/// Creates a new channel network
public fun create_network(clock: &Clock, ctx: &mut TxContext): ChannelNetwork {
    let coordinator = ctx.sender();
    let created_at = clock.timestamp_ms();

    event::emit(NetworkCreated { coordinator, created_at });

    ChannelNetwork {
        id: object::new(ctx),
        coordinator,
        participants: vector[],
        links: vector[],
        status: NETWORK_OPEN,
        total_payments: 0,
        total_volume: 0,
        created_at,
    }
}

/// Registers a participant in the network (coordinator only)
public fun register_participant(
    network: &mut ChannelNetwork,
    participant_address: address,
    fee_policy: hop::FeePolicy,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == network.coordinator, ENotAuthorized);
    assert!(network.status == NETWORK_OPEN, EInvalidState);
    assert!(network.participants.length() < MAX_PARTICIPANTS, EMaxParticipantsExceeded);

    // Check not already registered
    let len = network.participants.length();
    let mut i = 0;
    while (i < len) {
        assert!(network.participants[i].address != participant_address, EAlreadyExists);
        i = i + 1;
    };

    let index = len;
    let routing_node = hop::create_routing_node(participant_address, fee_policy);

    network
        .participants
        .push_back(Participant {
            address: participant_address,
            routing_node,
            index,
        });

    event::emit(ParticipantRegistered {
        address: participant_address,
        participant_count: network.participants.length(),
    });
}

/// Adds a link between two participants (references an existing tunnel)
public fun add_link(
    network: &mut ChannelNetwork,
    tunnel_id: vector<u8>,
    party_a: address,
    party_b: address,
    capacity_a_to_b: u64,
    capacity_b_to_a: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == network.coordinator, ENotAuthorized);
    assert!(network.status == NETWORK_OPEN, EInvalidState);
    assert!(network.links.length() < MAX_LINKS, EMaxHopsExceeded);
    assert!(party_a != party_b, EInvalidParameter);

    // Both parties must be registered participants
    assert!(is_participant(network, party_a), ENotFound);
    assert!(is_participant(network, party_b), ENotFound);

    // Check no duplicate link between same parties
    let link_count = network.links.length();
    let mut i = 0;
    while (i < link_count) {
        let link = &network.links[i];
        assert!(
            !(
                (link.party_a == party_a && link.party_b == party_b) ||
            (link.party_a == party_b && link.party_b == party_a),
            ),
            EAlreadyExists,
        );
        i = i + 1;
    };

    let index = link_count;
    network
        .links
        .push_back(ChannelLink {
            tunnel_id,
            party_a,
            party_b,
            capacity_a_to_b,
            capacity_b_to_a,
            status: LINK_ACTIVE,
            total_routed: 0,
            index,
        });

    event::emit(LinkAdded { party_a, party_b, tunnel_id });
}

/// Updates link capacity (after off-chain state changes)
public fun update_link_capacity(
    network: &mut ChannelNetwork,
    link_index: u64,
    new_capacity_a_to_b: u64,
    new_capacity_b_to_a: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == network.coordinator, ENotAuthorized);
    assert!(link_index < network.links.length(), ENotFound);

    let link = &mut network.links[link_index];
    assert!(link.status == LINK_ACTIVE, EInvalidState);

    link.capacity_a_to_b = new_capacity_a_to_b;
    link.capacity_b_to_a = new_capacity_b_to_a;
}

// ============================================
// PAYMENT ROUTING FUNCTIONS
// ============================================

/// Creates a routed payment through the network
public fun create_routed_payment(
    network: &ChannelNetwork,
    destination: address,
    amount: u64,
    payment_hash: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): RoutedPayment {
    assert!(network.status == NETWORK_OPEN, EInvalidState);
    assert!(amount > 0, EInvalidParameter);
    assert!(payment_hash.length() == 32, EInvalidParameter);

    let source = ctx.sender();
    assert!(source != destination, EInvalidParameter);

    let timestamp = clock.timestamp_ms();
    let route = hop::create_route(source, destination, amount, timestamp);

    RoutedPayment {
        id: object::new(ctx),
        route,
        payment_hash,
        preimage: vector[],
        amount,
        total_fees: 0,
        htlcs: vector[],
        settled_count: 0,
        status: PAYMENT_PENDING,
        source,
        destination,
    }
}

/// Adds a hop to the routed payment path
public fun add_routing_hop(
    payment: &mut RoutedPayment,
    network: &ChannelNetwork,
    link_index: u64,
    node_address: address,
    fee: u64,
    timeout_ms: u64,
) {
    assert!(payment.status == PAYMENT_PENDING, EInvalidState);
    assert!(link_index < network.links.length(), ENotFound);

    let link = &network.links[link_index];
    assert!(link.status == LINK_ACTIVE, EInvalidState);

    payment
        .route
        .add_hop(
            link.tunnel_id,
            node_address,
            fee,
            timeout_ms,
        );
    payment.total_fees = payment.total_fees + fee;
}

/// Activates the payment (sets up HTLCs along the path)
public fun activate_payment(
    payment: &mut RoutedPayment,
    network: &mut ChannelNetwork,
    base_timeout_ms: u64,
) {
    assert!(payment.status == PAYMENT_PENDING, EInvalidState);

    let route = &payment.route;
    let hop_count = route.route_hop_count();
    assert!(hop_count > 0, EInvalidHop);

    // Validate route
    let validation = route.validate_route();
    assert!(validation.validation_valid(), EInvalidHop);

    // Create cascading timeouts
    let timeouts = hop::create_cascading_timeouts(
        base_timeout_ms,
        hop_count,
        DEFAULT_HOP_TIMEOUT_MS,
    );

    // Create HTLCs for each hop (work backwards for amounts)
    let mut current_amount = payment.amount;
    let mut i = hop_count;
    while (i > 0) {
        i = i - 1;
        let hop_ref = route.route_hop(i);
        let fee = hop_ref.hop_fee();

        let htlc_amount = if (i == hop_count - 1) {
            payment.amount
        } else {
            current_amount + fee
        };
        current_amount = htlc_amount;

        let sender_addr = if (i == 0) {
            route.route_sender()
        } else {
            let prev_hop = route.route_hop(i - 1);
            prev_hop.hop_node_address()
        };

        let htlc = hop::create_htlc(
            payment.payment_hash,
            htlc_amount,
            sender_addr,
            hop_ref.hop_node_address(),
            timeouts[i],
        );
        payment.htlcs.push_back(htlc);
    };

    // Reverse to forward order
    payment.htlcs.reverse();

    payment.route.activate_route();

    // Update network stats
    network.total_payments = network.total_payments + 1;
    network.total_volume = network.total_volume + payment.amount;

    event::emit(PaymentRouted {
        source: payment.source,
        destination: payment.destination,
        amount: payment.amount,
        hop_count,
    });
}

/// Claims a routed payment with the preimage (receiver)
public fun claim_routed_payment(payment: &mut RoutedPayment, preimage: vector<u8>): bool {
    assert!(payment.status == PAYMENT_PENDING, EInvalidState);

    // Verify the preimage matches
    let computed_hash = hop::create_payment_hash(&preimage);
    if (computed_hash != payment.payment_hash) {
        return false
    };

    // Claim all HTLCs with the preimage (backwards)
    let htlc_count = payment.htlcs.length();
    let mut i = htlc_count;
    while (i > 0) {
        i = i - 1;
        let htlc = &mut payment.htlcs[i];
        let claimed = htlc.claim_htlc_internal(preimage);
        assert!(claimed, EInvalidState);
    };

    payment.preimage = preimage;
    payment.settled_count = htlc_count;
    payment.status = PAYMENT_COMPLETED;
    payment.route.complete_route();

    event::emit(PaymentSettled {
        source: payment.source,
        destination: payment.destination,
        amount: payment.amount,
        fees: payment.total_fees,
    });

    true
}

/// Fails a routed payment (sender only, on timeout)
public fun fail_routed_payment(payment: &mut RoutedPayment, clock: &Clock, ctx: &TxContext) {
    assert!(ctx.sender() == payment.source, ENotAuthorized);
    assert!(payment.status == PAYMENT_PENDING, EInvalidState);

    let current_time_ms = clock.timestamp_ms();

    // Expire any pending HTLCs. Intermediary hops have non-source senders, so the
    // sender-gated hop::expire_htlc would abort on the first such hop; the route source is
    // already authorized above, so use the package-internal variant (mirrors
    // example_multi_hop_payment::fail_payment).
    payment.htlcs.do_mut!(|htlc| {
        if (htlc.htlc_status() == hop::htlc_status_pending()) {
            htlc.expire_htlc_internal(current_time_ms);
        };
    });

    payment.status = PAYMENT_FAILED;
    payment.route.fail_route();
}

// ============================================
// SETTLEMENT AND DISPUTE FUNCTIONS
// ============================================

/// Marks a link as settling (no more payments through it)
public fun begin_link_settlement(network: &mut ChannelNetwork, link_index: u64, ctx: &TxContext) {
    assert!(ctx.sender() == network.coordinator, ENotAuthorized);
    assert!(link_index < network.links.length(), ENotFound);

    let link = &mut network.links[link_index];
    assert!(link.status == LINK_ACTIVE, EInvalidState);

    link.status = LINK_SETTLING;
}

/// Marks a link as settled with final balances
public fun settle_link(
    network: &mut ChannelNetwork,
    link_index: u64,
    party_a_final: u64,
    party_b_final: u64,
    ctx: &TxContext,
): LinkSettlement {
    assert!(ctx.sender() == network.coordinator, ENotAuthorized);
    assert!(link_index < network.links.length(), ENotFound);

    let link = &mut network.links[link_index];
    assert!(link.status == LINK_SETTLING || link.status == LINK_ACTIVE, EInvalidState);

    link.status = LINK_SETTLED;

    event::emit(LinkSettledEvent {
        tunnel_id: link.tunnel_id,
        party_a: link.party_a,
        party_b: link.party_b,
    });

    LinkSettlement {
        tunnel_id: link.tunnel_id,
        party_a_final,
        party_b_final,
        total_routed: link.total_routed,
    }
}

/// Marks a link as disputed (demonstrates dispute isolation)
public fun mark_link_disputed(network: &mut ChannelNetwork, link_index: u64, ctx: &TxContext) {
    assert!(link_index < network.links.length(), ENotFound);

    let link = &mut network.links[link_index];
    assert!(link.status == LINK_ACTIVE, EInvalidState);

    // Either the coordinator or a party in the link can dispute
    let sender = ctx.sender();
    assert!(
        sender == network.coordinator ||
        sender == link.party_a ||
        sender == link.party_b,
        ENotAuthorized,
    );

    link.status = LINK_DISPUTED;

    event::emit(LinkDisputed {
        tunnel_id: link.tunnel_id,
        party_a: link.party_a,
        party_b: link.party_b,
    });
}

/// Resolves a disputed link
public fun resolve_link_dispute(
    network: &mut ChannelNetwork,
    link_index: u64,
    party_a_final: u64,
    party_b_final: u64,
    ctx: &TxContext,
): LinkSettlement {
    assert!(ctx.sender() == network.coordinator, ENotAuthorized);
    assert!(link_index < network.links.length(), ENotFound);

    let link = &mut network.links[link_index];
    assert!(link.status == LINK_DISPUTED, EInvalidState);

    link.status = LINK_SETTLED;

    event::emit(LinkSettledEvent {
        tunnel_id: link.tunnel_id,
        party_a: link.party_a,
        party_b: link.party_b,
    });

    LinkSettlement {
        tunnel_id: link.tunnel_id,
        party_a_final,
        party_b_final,
        total_routed: link.total_routed,
    }
}

/// Begins network-wide settlement
public fun begin_network_settlement(network: &mut ChannelNetwork, ctx: &TxContext) {
    assert!(ctx.sender() == network.coordinator, ENotAuthorized);
    assert!(network.status == NETWORK_OPEN, EInvalidState);

    network.status = NETWORK_SETTLING;
}

/// Closes the network (all links must be settled)
public fun close_network(network: &mut ChannelNetwork, ctx: &TxContext) {
    assert!(ctx.sender() == network.coordinator, ENotAuthorized);
    assert!(network.status == NETWORK_SETTLING, EInvalidState);
    assert!(all_links_settled(network), EInvalidState);

    network.status = NETWORK_CLOSED;

    event::emit(NetworkClosed {
        coordinator: network.coordinator,
        total_payments: network.total_payments,
        total_volume: network.total_volume,
    });
}

// ============================================
// NETWORK ACCESSORS
// ============================================

public fun network_coordinator(network: &ChannelNetwork): address { network.coordinator }

public fun network_participant_count(network: &ChannelNetwork): u64 {
    network.participants.length()
}

public fun network_link_count(network: &ChannelNetwork): u64 {
    network.links.length()
}

public fun network_status(network: &ChannelNetwork): u8 { network.status }

public fun network_total_payments(network: &ChannelNetwork): u64 { network.total_payments }

public fun network_total_volume(network: &ChannelNetwork): u64 { network.total_volume }

public fun network_created_at(network: &ChannelNetwork): u64 { network.created_at }

// ============================================
// PARTICIPANT ACCESSORS
// ============================================

public fun participant_address(p: &Participant): address { p.address }

public fun participant_index(p: &Participant): u64 { p.index }

public fun participant_routing_node(p: &Participant): &hop::RoutingNode { &p.routing_node }

public fun get_participant(network: &ChannelNetwork, index: u64): &Participant {
    assert!(index < network.participants.length(), ENotFound);
    &network.participants[index]
}

// ============================================
// LINK ACCESSORS
// ============================================

public fun link_tunnel_id(link: &ChannelLink): &vector<u8> { &link.tunnel_id }

public fun link_party_a(link: &ChannelLink): address { link.party_a }

public fun link_party_b(link: &ChannelLink): address { link.party_b }

public fun link_capacity_a_to_b(link: &ChannelLink): u64 { link.capacity_a_to_b }

public fun link_capacity_b_to_a(link: &ChannelLink): u64 { link.capacity_b_to_a }

public fun link_status(link: &ChannelLink): u8 { link.status }

public fun link_total_routed(link: &ChannelLink): u64 { link.total_routed }

public fun link_index(link: &ChannelLink): u64 { link.index }

public fun get_link(network: &ChannelNetwork, index: u64): &ChannelLink {
    assert!(index < network.links.length(), ENotFound);
    &network.links[index]
}

// ============================================
// ROUTED PAYMENT ACCESSORS
// ============================================

public fun routed_payment_status(payment: &RoutedPayment): u8 { payment.status }

public fun routed_payment_amount(payment: &RoutedPayment): u64 { payment.amount }

public fun routed_payment_total_fees(payment: &RoutedPayment): u64 { payment.total_fees }

public fun routed_payment_source(payment: &RoutedPayment): address { payment.source }

public fun routed_payment_destination(payment: &RoutedPayment): address { payment.destination }

public fun routed_payment_htlc_count(payment: &RoutedPayment): u64 { payment.htlcs.length() }

public fun routed_payment_settled_count(payment: &RoutedPayment): u64 { payment.settled_count }

public fun routed_payment_route(payment: &RoutedPayment): &hop::Route { &payment.route }

public fun routed_payment_hash(payment: &RoutedPayment): &vector<u8> { &payment.payment_hash }

// ============================================
// LINK SETTLEMENT ACCESSORS
// ============================================

public fun settlement_tunnel_id(s: &LinkSettlement): &vector<u8> { &s.tunnel_id }

public fun settlement_party_a_final(s: &LinkSettlement): u64 { s.party_a_final }

public fun settlement_party_b_final(s: &LinkSettlement): u64 { s.party_b_final }

public fun settlement_total_routed(s: &LinkSettlement): u64 { s.total_routed }

// ============================================
// NETWORK PAYMENT RECEIPT ACCESSORS
// ============================================

public fun receipt_route_id(r: &NetworkPaymentReceipt): &vector<u8> { &r.route_id }

public fun receipt_source(r: &NetworkPaymentReceipt): address { r.source }

public fun receipt_destination(r: &NetworkPaymentReceipt): address { r.destination }

public fun receipt_amount(r: &NetworkPaymentReceipt): u64 { r.amount }

public fun receipt_fees(r: &NetworkPaymentReceipt): u64 { r.fees }

public fun receipt_hop_count(r: &NetworkPaymentReceipt): u64 { r.hop_count }

public fun receipt_completed_at(r: &NetworkPaymentReceipt): u64 { r.completed_at }

// ============================================
// UTILITY FUNCTIONS
// ============================================

/// Creates a receipt for a completed network payment
public fun create_payment_receipt(
    payment: &RoutedPayment,
    completed_at: u64,
): NetworkPaymentReceipt {
    assert!(payment.status == PAYMENT_COMPLETED, EInvalidState);

    NetworkPaymentReceipt {
        route_id: *payment.route.route_id(),
        source: payment.source,
        destination: payment.destination,
        amount: payment.amount,
        fees: payment.total_fees,
        hop_count: payment.route.route_hop_count(),
        completed_at,
    }
}

/// Checks if an address is a registered participant
public fun is_participant(network: &ChannelNetwork, addr: address): bool {
    let len = network.participants.length();
    let mut i = 0;
    while (i < len) {
        if (network.participants[i].address == addr) {
            return true
        };
        i = i + 1;
    };
    false
}

/// Finds the link index between two addresses (returns option)
public fun find_link_between(
    network: &ChannelNetwork,
    addr_a: address,
    addr_b: address,
): Option<u64> {
    let len = network.links.length();
    let mut i = 0;
    while (i < len) {
        let link = &network.links[i];
        if (
            (link.party_a == addr_a && link.party_b == addr_b) ||
            (link.party_a == addr_b && link.party_b == addr_a)
        ) {
            return option::some(i)
        };
        i = i + 1;
    };
    option::none()
}

/// Counts the number of active links
public fun count_active_links(network: &ChannelNetwork): u64 {
    let mut count = 0;
    let len = network.links.length();
    let mut i = 0;
    while (i < len) {
        if (network.links[i].status == LINK_ACTIVE) {
            count = count + 1;
        };
        i = i + 1;
    };
    count
}

/// Counts the number of settled links
public fun count_settled_links(network: &ChannelNetwork): u64 {
    let mut count = 0;
    let len = network.links.length();
    let mut i = 0;
    while (i < len) {
        if (network.links[i].status == LINK_SETTLED) {
            count = count + 1;
        };
        i = i + 1;
    };
    count
}

/// Checks if all links are settled
public fun all_links_settled(network: &ChannelNetwork): bool {
    let len = network.links.length();
    let mut i = 0;
    while (i < len) {
        if (network.links[i].status != LINK_SETTLED) {
            return false
        };
        i = i + 1;
    };
    true
}

/// Creates a payment hash from a preimage (convenience wrapper)
public fun create_payment_hash(preimage: &vector<u8>): vector<u8> {
    hop::create_payment_hash(preimage)
}

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_network_for_testing(network: ChannelNetwork) {
    let ChannelNetwork { id, .. } = network;
    id.delete();
}

#[test_only]
public fun destroy_payment_for_testing(payment: RoutedPayment) {
    let RoutedPayment { id, .. } = payment;
    id.delete();
}
