//! The sans-IO tunnel core: the synchronous `Protocol`/`Signer` seams, the wire
//! frame codec, shared value types, and the `TunnelSeat` state machine. No IO,
//! no async runtime — fleets (serve/bench) drive this by pumping frames.
pub mod error;
pub mod types;
pub use error::{AnchorError, ChannelError, HarnessError, ProtocolError};
pub use types::{Balances, PolicyContext, Seat, TunnelContext};

pub mod protocol;
pub use protocol::Protocol;

pub mod frame;
pub use frame::{decode_frame, encode_frame, AckFrame, Frame, MoveFrame, WireSeat};

pub mod signer;
pub use signer::{local::LocalSigner, Signer};

pub mod seat;
pub use seat::TunnelSeat;
