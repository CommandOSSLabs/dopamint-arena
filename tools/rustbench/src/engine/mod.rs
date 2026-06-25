//! Byte-exact port of the tunnel engine hot path.
//!
//! Every serializer here MUST produce bytes identical to the Move serializers in
//! `sui_tunnel/sources/tunnel.move` and the TS mirror in
//! `sui-tunnel-ts/src/core/wire.ts`. Verified by `tests/golden.rs`.

pub mod codec;
pub mod crypto;
pub mod wire;
pub mod commitment;
