//! Bot-fleet: server-side bots that play real human users at blackjack over the relay
//! as genuine two-party state-channel games, built on the `tunnel-harness` engine.
//!
//! The harness ([`tunnel_harness`]) supplies the sans-IO `PartyRuntime` core, the byte-exact
//! game protocol ([`tunnel_blackjack`]), the async `PartyDriver`, and the seams we plug into:
//!   * [`relay_channel`] (`RelayChannel`) — implements the `FrameTransport` seam over the relay
//!     WS. The runtime's `JsonFrameCodec` already speaks the TS wire, so [`relay_envelope`] only
//!     adds the `{t,kind,data}` relay envelope.
//!   * [`signer_durable`] (`DurableSigner`) — the `Signer` seam with a key that survives restarts.
//!   * [`relay_client`] / [`relay_wire`] — the `/v1/mp` connect + matchmaking handshake.
//!
//! On-chain open/settle/dispute is a separate layer (the engine is sans-IO) — see the spec.

pub mod anchor;
pub mod match_channel;
pub mod peer;
pub mod play_match;
pub mod relay_channel;
pub mod relay_client;
pub mod relay_envelope;
pub mod relay_wire;
pub mod relay_ws;
pub mod signer_durable;

/// A match seat as assigned by the relay's `match.found` (`role: "A" | "B"`). Role B (dealer)
/// opens+funds the tunnel and submits the cooperative settle; role A (player) deposits and waits.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    A,
    B,
}

impl Role {
    pub fn seat(self) -> tunnel_harness::Seat {
        match self {
            Role::A => tunnel_harness::Seat::A,
            Role::B => tunnel_harness::Seat::B,
        }
    }
}
