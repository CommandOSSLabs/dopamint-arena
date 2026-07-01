//! Serde adapters for protocol MOVE-wire byte fields, shared by every protocol crate.
//!
//! In a human-readable format (JSON — the cross-language relay wire) byte fields ride as hex strings
//! and `u64`s as decimal strings, so a Rust bot and a browser co-sign byte-identical relayed moves. In
//! binary codecs (bcs/postcard — the Rust-only bench) the adapters fall back to default serde, keeping
//! those wires byte-identical to the derived layout. Use via
//! `#[serde(with = "tunnel_harness::wire_hex::<adapter>")]`.
//!
//! **Bare vs `0x` is load-bearing**: the prefix is part of the signed/hashed bytes, so the two
//! families are NOT interchangeable — each field must keep the encoding its FE counterpart emits
//! (`bytesToHex` ⇒ bare, `toHex` ⇒ `0x`). Deserialization tolerates an optional `0x` either way.

use serde::ser::SerializeSeq;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

fn hex_string(bytes: &[u8], prefix: bool) -> String {
    let body = hex::encode(bytes);
    if prefix {
        format!("0x{body}")
    } else {
        body
    }
}

fn decode_hex<E: serde::de::Error>(s: &str) -> Result<Vec<u8>, E> {
    hex::decode(s.strip_prefix("0x").unwrap_or(s)).map_err(E::custom)
}

fn decode_array32<E: serde::de::Error>(s: &str) -> Result<[u8; 32], E> {
    decode_hex::<E>(s)?
        .as_slice()
        .try_into()
        .map_err(|_| E::custom("expected 32 bytes"))
}

/// `Vec<u8>` as **bare** lowercase hex (`bytesToHex`).
pub mod bytes {
    use super::*;
    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            s.serialize_str(&hex_string(v, false))
        } else {
            v.serialize(s)
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        if d.is_human_readable() {
            decode_hex(&String::deserialize(d)?)
        } else {
            Vec::<u8>::deserialize(d)
        }
    }
}

/// `Vec<u8>` as **`0x`-prefixed** lowercase hex (`toHex`).
pub mod bytes_0x {
    use super::*;
    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            s.serialize_str(&hex_string(v, true))
        } else {
            v.serialize(s)
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        if d.is_human_readable() {
            decode_hex(&String::deserialize(d)?)
        } else {
            Vec::<u8>::deserialize(d)
        }
    }
}

/// `[u8; 32]` as **bare** hex.
pub mod array32 {
    use super::*;
    pub fn serialize<S: Serializer>(v: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            s.serialize_str(&hex_string(v, false))
        } else {
            v.serialize(s)
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        if d.is_human_readable() {
            decode_array32(&String::deserialize(d)?)
        } else {
            <[u8; 32]>::deserialize(d)
        }
    }
}

/// `Vec<[u8; 32]>` as a sequence of **bare** hex strings.
pub mod vec_array32 {
    use super::*;
    pub fn serialize<S: Serializer>(v: &[[u8; 32]], s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            let mut seq = s.serialize_seq(Some(v.len()))?;
            for item in v {
                seq.serialize_element(&hex_string(item, false))?;
            }
            seq.end()
        } else {
            v.serialize(s)
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<[u8; 32]>, D::Error> {
        if d.is_human_readable() {
            Vec::<String>::deserialize(d)?
                .into_iter()
                .map(|s| decode_array32(&s))
                .collect()
        } else {
            Vec::<[u8; 32]>::deserialize(d)
        }
    }
}

/// `Vec<[u8; 32]>` as a sequence of **`0x`-prefixed** hex strings.
pub mod vec_array32_0x {
    use super::*;
    pub fn serialize<S: Serializer>(v: &[[u8; 32]], s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            let mut seq = s.serialize_seq(Some(v.len()))?;
            for item in v {
                seq.serialize_element(&hex_string(item, true))?;
            }
            seq.end()
        } else {
            v.serialize(s)
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<[u8; 32]>, D::Error> {
        if d.is_human_readable() {
            Vec::<String>::deserialize(d)?
                .into_iter()
                .map(|s| decode_array32(&s))
                .collect()
        } else {
            Vec::<[u8; 32]>::deserialize(d)
        }
    }
}

/// `u64` as a decimal string in human-readable formats (JS-safe past 2^53).
pub mod dec_u64 {
    use super::*;
    pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            s.serialize_str(&v.to_string())
        } else {
            v.serialize(s)
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        if d.is_human_readable() {
            String::deserialize(d)?
                .parse()
                .map_err(serde::de::Error::custom)
        } else {
            u64::deserialize(d)
        }
    }
}
