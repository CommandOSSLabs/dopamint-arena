//! The tunnel harness: five swappable seams + the seat-driver loop + the fleet.
pub mod error;
pub mod types;
pub use error::{AnchorError, ChannelError, HarnessError, ProtocolError};
pub use types::{Balances, PolicyContext, Seat, TunnelContext};

pub mod protocol;
pub use protocol::Protocol;

pub mod frame;
pub use frame::{decode_frame, encode_frame, AckFrame, Frame, MoveFrame};

pub mod channel;
pub use channel::{in_memory::InMemoryChannel, Channel};

pub mod signer;
pub use signer::{local::LocalSigner, Signer};

pub mod anchor;
pub use anchor::{
    noop::NoopAnchor, Anchor, Challenge, CoSignedSettlement, DisputeEvidence, OpenParams,
    TunnelHandle, TxDigest,
};

pub mod policy;
pub use policy::{random::RandomPolicy, Policy};

pub mod driver;
pub use driver::{DriverOutcome, SeatDriver};

pub mod fleet;
pub use fleet::{DriverUnit, FleetSupervisor, Metrics};
