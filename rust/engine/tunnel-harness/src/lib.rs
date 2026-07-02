//! The tunnel harness: protocol rules, signing, frame codecs, party runtime,
//! pluggable strategy/transport seams, and the generic party driver. Protocol
//! transitions stay synchronous and deterministic; IO enters through explicit
//! harness seams.
pub mod error;
pub mod types;
pub use error::{FrameTransportError, HarnessError, ProtocolError, TunnelAnchorError};
pub use types::{Balances, MoveStrategyContext, Seat, TunnelContext};

pub mod protocol;
pub use protocol::Protocol;

pub mod wire_hex;

pub mod frame;
pub use frame::{
    AckFrame, BcsFrameCodec, CodecError, FrameCodec, JsonFrameCodec, MoveFrame, PostcardFrameCodec,
    TunnelFrame, WireSeat,
};

pub mod signer;
pub use signer::{local::LocalSigner, Signer};

pub mod seat;
pub use seat::PartyRuntime;

pub mod frame_transport;
pub use frame_transport::{in_memory::InMemoryFrameTransport, FrameTransport};

pub mod move_strategy;
pub use move_strategy::{random::RandomMoveStrategy, MoveStrategy};

pub mod party_driver;
pub use party_driver::{DriverOutcome, DriverRunControl, PartyDriver, SeatParts};

pub mod observer;
pub use observer::{DriverObserver, DriverStart, MoveCommitted};

pub mod transcript;
pub use transcript::{
    BcsTranscriptCodec, InMemoryTranscriptRecorder, JsonTranscriptCodec, NullTranscriptRecorder,
    PostcardTranscriptCodec, RootOnlyTranscriptRecorder, Transcript, TranscriptCodec,
    TranscriptEntry, TranscriptError, TranscriptRecorder,
};

pub mod anchor;
pub mod instrument;
pub use anchor::{
    InMemoryAnchor, OpenedTunnel, SettledTunnel, SettlementMode, TranscriptSettleEntry,
    TunnelAnchor, TunnelOpenRequest, TunnelSettleRequest,
};
