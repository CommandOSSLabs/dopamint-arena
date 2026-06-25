# rustbench Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `rustbench` crate and port the byte-exact tunnel engine hot path (wire serializers, commit-reveal, blake2b, ed25519), proven byte-identical to the TS/Move golden vectors.

**Architecture:** A new independent workspace crate `tools/rustbench`. This plan delivers only the `engine/` module — the foundation gate. Nothing downstream (blackjack moves, fleet, channels, anchors) proceeds until `cargo test -p rustbench` is green on byte-identity against the captured golden vectors. The port mirrors `sui-tunnel-ts/src/core/{wire,commitment,crypto}.ts` and is cross-checked against the same vectors the Move tests use (`sui_tunnel/tests/wire_format_tests.move`).

**Tech Stack:** Rust 2021, `blake2` (BLAKE2b-256), `ed25519-dalek` v2 (RFC-8032 deterministic signatures), `hex` (workspace dep) for test vectors. Built with the workspace `[profile.release]` (`lto = "thin"`, `codegen-units = 1`).

## Global Constraints

- Crate path `tools/rustbench`, package name `rustbench`, added to root `Cargo.toml` `members`.
- Workspace inheritance: `edition = "2021"`, `rust-version = "1.80"`, `license = "Apache-2.0"`, `publish = false`.
- **Byte-exactness is the contract.** All u64 fields are **8-byte BIG-ENDIAN** (`u64::to_be_bytes`), NOT BCS little-endian. Domain prefixes are inlined ASCII with NO length prefix. `state_update` and `settlement` use DIFFERENT field orderings (see each task).
- `blake2b256` = unkeyed BLAKE2b with **32-byte** output (`blake2::Blake2b<U32>`).
- ed25519 secret keys are 32-byte seeds; signing is deterministic — fixed secrets give reproducible signatures.
- Do not touch `backend/` crates, `sui-tunnel-ts/`, or `tools/loadbench/` in this plan.

---

### Task 1: Scaffold the crate

**Files:**
- Create: `tools/rustbench/Cargo.toml`
- Create: `tools/rustbench/src/lib.rs`
- Modify: `Cargo.toml` (root workspace `members`)

**Interfaces:**
- Consumes: nothing.
- Produces: a buildable `rustbench` library crate with `engine` module declared.

- [ ] **Step 1: Add the crate to the workspace**

In root `Cargo.toml`, change the members line to:

```toml
members = ["backend/tunnel-manager", "backend/explorer", "backend/shared", "tools/rustbench"]
```

Add to `[workspace.dependencies]` (so the crate inherits pinned versions):

```toml
blake2 = "0.10"
ed25519-dalek = "2"
```

- [ ] **Step 2: Create `tools/rustbench/Cargo.toml`**

```toml
[package]
name = "rustbench"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
license.workspace = true
publish.workspace = true

[dependencies]
blake2.workspace = true
ed25519-dalek.workspace = true
hex.workspace = true

[dev-dependencies]
hex.workspace = true
```

- [ ] **Step 3: Create `tools/rustbench/src/lib.rs`**

```rust
//! rustbench — Rust throughput-ceiling bench for the Sui Tunnel engine.
//!
//! This crate ports the byte-exact off-chain hot path of `sui-tunnel-ts`.
//! See docs/superpowers/specs/2026-06-25-rustbench-blackjack-design.md.

pub mod engine;
```

- [ ] **Step 4: Create `tools/rustbench/src/engine/mod.rs`**

```rust
//! Byte-exact port of the tunnel engine hot path.
//!
//! Every serializer here MUST produce bytes identical to the Move serializers in
//! `sui_tunnel/sources/tunnel.move` and the TS mirror in
//! `sui-tunnel-ts/src/core/wire.ts`. Verified by `tests/golden.rs`.

pub mod codec;
pub mod crypto;
pub mod wire;
pub mod commitment;
```

- [ ] **Step 5: Create empty module files so the crate compiles**

Create `tools/rustbench/src/engine/codec.rs`, `crypto.rs`, `wire.rs`, `commitment.rs`, each containing only:

```rust
// filled in by later tasks
```

- [ ] **Step 6: Verify the crate builds**

Run: `cargo build -p rustbench`
Expected: PASS (compiles; empty modules are fine).

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml tools/rustbench
git commit -m "feat(rustbench): scaffold crate and engine module"
```

---

### Task 2: Big-endian u64 and address codec

**Files:**
- Modify: `tools/rustbench/src/engine/codec.rs`
- Test: in-file `#[cfg(test)]` module.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub fn u64_to_be_bytes(v: u64) -> [u8; 8]`
  - `pub fn address_to_bytes32(addr: &str) -> Result<[u8; 32], String>` — accepts hex with/without `0x`, left-zero-pads to 32 bytes, errors on non-hex or >32 bytes.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_left_pads_short_hex() {
        // "0xab" -> 31 zero bytes then 0xab, matching wire.ts addressToBytes32.
        let got = address_to_bytes32("0xab").unwrap();
        let mut want = [0u8; 32];
        want[31] = 0xab;
        assert_eq!(got, want);
    }

    #[test]
    fn address_rejects_too_long() {
        let long = format!("0x{}", "a".repeat(66));
        assert!(address_to_bytes32(&long).is_err());
    }

    #[test]
    fn u64_be_is_big_endian() {
        assert_eq!(u64_to_be_bytes(0x499602d2), [0, 0, 0, 0, 0x49, 0x96, 0x02, 0xd2]);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p rustbench codec`
Expected: FAIL (functions not defined).

- [ ] **Step 3: Write the implementation (above the test module)**

```rust
//! Big-endian integer + address encoding, matching `wire.ts` / `signature.move`.

/// 8-byte big-endian encoding of a u64. Matches `signature::u64_to_be_bytes`.
pub fn u64_to_be_bytes(v: u64) -> [u8; 8] {
    v.to_be_bytes()
}

/// 32-byte left-zero-padded big-endian address/object-id, matching
/// `wire.ts::addressToBytes32` / Move `address.to_bytes()`. Accepts `0x` prefix.
pub fn address_to_bytes32(addr: &str) -> Result<[u8; 32], String> {
    let h = addr.strip_prefix("0x").or_else(|| addr.strip_prefix("0X")).unwrap_or(addr);
    if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("invalid hex address: {addr}"));
    }
    if h.len() > 64 {
        return Err(format!("address longer than 32 bytes: {addr}"));
    }
    let padded = format!("{:0>64}", h);
    let mut out = [0u8; 32];
    hex::decode_to_slice(&padded, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p rustbench codec`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/rustbench/src/engine/codec.rs
git commit -m "feat(rustbench): big-endian u64 and address codec"
```

---

### Task 3: blake2b256 and ed25519 crypto

**Files:**
- Modify: `tools/rustbench/src/engine/crypto.rs`
- Test: in-file `#[cfg(test)]` module.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub fn blake2b256(data: &[u8]) -> [u8; 32]`
  - `pub struct KeyPair { pub signing: ed25519_dalek::SigningKey }`
  - `pub fn keypair_from_secret(secret: &[u8; 32]) -> KeyPair`
  - `KeyPair::public_key(&self) -> [u8; 32]`
  - `KeyPair::sign(&self, msg: &[u8]) -> [u8; 64]`
  - `pub fn verify(pk: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> bool`

- [ ] **Step 1: Write the failing test (vectors from golden.gen.ts)**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> Vec<u8> { hex::decode(s).unwrap() }

    #[test]
    fn blake2b256_matches_golden_hello() {
        let got = blake2b256(b"hello");
        assert_eq!(hex::encode(got),
            "324dcf027dd4a30a932c441f365a25e86b173defa4b8e58948253471b81b72cf");
    }

    #[test]
    fn ed25519_public_key_matches_golden() {
        // secretA = 0x01..0x20
        let secret: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let kp = keypair_from_secret(&secret);
        assert_eq!(hex::encode(kp.public_key()),
            "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664");
    }

    #[test]
    fn ed25519_signature_matches_golden() {
        // The state_update golden message, signed by secretA -> SIG_A.
        let su = h("7375695f74756e6e656c3a3a73746174655f75706461746500000000000000000000000000000000000000000000000000000000000000ab0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20000000000000002a00000000499602d200000000000003e800000000000007d0");
        let secret: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let kp = keypair_from_secret(&secret);
        let sig = kp.sign(&su);
        assert_eq!(hex::encode(sig),
            "6941c8ba5bd00d2695d5edd6d33e3fb3e46a83685e09717382b0b0b82246726323a6abc9bec1ebb8535bb3100a03bf5205e7ce5c898f8d071916c4c795ac180b");
        assert!(verify(&kp.public_key(), &su, &sig));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p rustbench crypto`
Expected: FAIL (functions not defined).

- [ ] **Step 3: Write the implementation (above the test module)**

```rust
//! blake2b256 + ed25519, matching `crypto.ts` (noble) and `signature.move`.

use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

type Blake2b256 = Blake2b<U32>;

/// Unkeyed BLAKE2b with 32-byte output. Matches `crypto.ts::blake2b256`.
pub fn blake2b256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Blake2b256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// An ed25519 keypair derived from a 32-byte seed (deterministic, RFC-8032).
pub struct KeyPair {
    pub signing: SigningKey,
}

pub fn keypair_from_secret(secret: &[u8; 32]) -> KeyPair {
    KeyPair { signing: SigningKey::from_bytes(secret) }
}

impl KeyPair {
    pub fn public_key(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.signing.sign(msg).to_bytes()
    }
}

/// Verify an ed25519 signature over the RAW message (no pre-hash).
pub fn verify(pk: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> bool {
    let Ok(vk) = VerifyingKey::from_bytes(pk) else { return false };
    vk.verify(msg, &Signature::from_bytes(sig)).is_ok()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p rustbench crypto`
Expected: PASS (3 tests). If the signature vector mismatches, the dalek/noble RFC-8032 assumption is wrong — STOP and report; do not adjust the vector.

- [ ] **Step 5: Commit**

```bash
git add tools/rustbench/src/engine/crypto.rs
git commit -m "feat(rustbench): blake2b256 and ed25519 crypto"
```

---

### Task 4: Wire serializers

**Files:**
- Modify: `tools/rustbench/src/engine/wire.rs`
- Test: in-file `#[cfg(test)]` module.

**Interfaces:**
- Consumes: `engine::codec::{u64_to_be_bytes, address_to_bytes32}`.
- Produces:
  - `pub struct StateUpdate { pub tunnel_id: String, pub state_hash: [u8; 32], pub nonce: u64, pub timestamp: u64, pub party_a_balance: u64, pub party_b_balance: u64 }`
  - `pub fn serialize_state_update(u: &StateUpdate) -> Vec<u8>`
  - `pub struct Settlement { pub tunnel_id: String, pub party_a_balance: u64, pub party_b_balance: u64, pub final_nonce: u64, pub timestamp: u64 }`
  - `pub fn serialize_settlement(s: &Settlement) -> Vec<u8>`
  - `pub fn serialize_settlement_with_root(s: &Settlement, transcript_root: &[u8; 32]) -> Vec<u8>`
  - `pub struct HtlcLock { pub tunnel_id: String, pub payment_hash: [u8; 32], pub amount: u64, pub sender: String, pub receiver: String, pub expiry_ms: u64 }`
  - `pub fn serialize_htlc_lock(h: &HtlcLock) -> Vec<u8>`
  - `pub const DOMAIN_STATE_UPDATE: &[u8]` and siblings.

- [ ] **Step 1: Write the failing test (golden vectors from golden.gen.ts)**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn state_hash_1_to_32() -> [u8; 32] { std::array::from_fn(|i| (i + 1) as u8) }

    #[test]
    fn state_update_matches_golden() {
        let u = StateUpdate {
            tunnel_id: "0xab".into(),
            state_hash: state_hash_1_to_32(),
            nonce: 42,
            timestamp: 1234567890,
            party_a_balance: 1000,
            party_b_balance: 2000,
        };
        assert_eq!(hex::encode(serialize_state_update(&u)),
            "7375695f74756e6e656c3a3a73746174655f75706461746500000000000000000000000000000000000000000000000000000000000000ab0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20000000000000002a00000000499602d200000000000003e800000000000007d0");
    }

    #[test]
    fn settlement_matches_golden() {
        let s = Settlement {
            tunnel_id: "0xab".into(),
            party_a_balance: 1000,
            party_b_balance: 2000,
            final_nonce: 43,
            timestamp: 1234567890,
        };
        assert_eq!(hex::encode(serialize_settlement(&s)),
            "7375695f74756e6e656c3a3a736574746c656d656e7400000000000000000000000000000000000000000000000000000000000000ab00000000000003e800000000000007d0000000000000002b00000000499602d2");
    }

    #[test]
    fn settlement_with_root_matches_golden() {
        let s = Settlement {
            tunnel_id: "0xab".into(),
            party_a_balance: 1000,
            party_b_balance: 2000,
            final_nonce: 43,
            timestamp: 1234567890,
        };
        assert_eq!(hex::encode(serialize_settlement_with_root(&s, &state_hash_1_to_32())),
            "7375695f74756e6e656c3a3a736574746c656d656e745f763200000000000000000000000000000000000000000000000000000000000000ab00000000000003e800000000000007d0000000000000002b00000000499602d20102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");
    }

    #[test]
    fn htlc_lock_matches_golden() {
        let h = HtlcLock {
            tunnel_id: "0xab".into(),
            payment_hash: state_hash_1_to_32(),
            amount: 500,
            sender: "0xaa".into(),
            receiver: "0xbb".into(),
            expiry_ms: 9999999,
        };
        assert_eq!(hex::encode(serialize_htlc_lock(&h)),
            "7375695f74756e6e656c3a3a68746c635f6c6f636b00000000000000000000000000000000000000000000000000000000000000ab0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2000000000000001f400000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000bb000000000098967f");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p rustbench wire`
Expected: FAIL (types/functions not defined).

- [ ] **Step 3: Write the implementation (above the test module)**

```rust
//! Canonical signed-message wire format. Byte-identical to `wire.ts` and the
//! Move serializers in `sui_tunnel/sources/tunnel.move`.
//!
//! Load-bearing: domain prefixes are inlined ASCII (no length prefix); all u64s
//! are 8-byte big-endian; `state_update` and `settlement` use DIFFERENT field
//! orderings. ed25519 verifies the RAW message — only `state_hash` is a digest.

use crate::engine::codec::{address_to_bytes32, u64_to_be_bytes};

pub const DOMAIN_STATE_UPDATE: &[u8] = b"sui_tunnel::state_update";
pub const DOMAIN_SETTLEMENT: &[u8] = b"sui_tunnel::settlement";
pub const DOMAIN_SETTLEMENT_V2: &[u8] = b"sui_tunnel::settlement_v2";
pub const DOMAIN_HTLC_LOCK: &[u8] = b"sui_tunnel::htlc_lock";

pub struct StateUpdate {
    pub tunnel_id: String,
    pub state_hash: [u8; 32],
    pub nonce: u64,
    pub timestamp: u64,
    pub party_a_balance: u64,
    pub party_b_balance: u64,
}

/// Mirrors `tunnel::serialize_state_update`.
/// Order: domain, id, state_hash, nonce, timestamp, balA, balB.
pub fn serialize_state_update(u: &StateUpdate) -> Vec<u8> {
    let id = address_to_bytes32(&u.tunnel_id).expect("valid tunnel id");
    let mut out = Vec::with_capacity(DOMAIN_STATE_UPDATE.len() + 32 + 32 + 32);
    out.extend_from_slice(DOMAIN_STATE_UPDATE);
    out.extend_from_slice(&id);
    out.extend_from_slice(&u.state_hash);
    out.extend_from_slice(&u64_to_be_bytes(u.nonce));
    out.extend_from_slice(&u64_to_be_bytes(u.timestamp));
    out.extend_from_slice(&u64_to_be_bytes(u.party_a_balance));
    out.extend_from_slice(&u64_to_be_bytes(u.party_b_balance));
    out
}

pub struct Settlement {
    pub tunnel_id: String,
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    pub final_nonce: u64,
    pub timestamp: u64,
}

/// Mirrors `tunnel::serialize_settlement`.
/// Order: domain, id, balA, balB, final_nonce, timestamp.
pub fn serialize_settlement(s: &Settlement) -> Vec<u8> {
    let id = address_to_bytes32(&s.tunnel_id).expect("valid tunnel id");
    let mut out = Vec::with_capacity(DOMAIN_SETTLEMENT.len() + 32 + 32);
    out.extend_from_slice(DOMAIN_SETTLEMENT);
    out.extend_from_slice(&id);
    out.extend_from_slice(&u64_to_be_bytes(s.party_a_balance));
    out.extend_from_slice(&u64_to_be_bytes(s.party_b_balance));
    out.extend_from_slice(&u64_to_be_bytes(s.final_nonce));
    out.extend_from_slice(&u64_to_be_bytes(s.timestamp));
    out
}

/// Mirrors `tunnel::serialize_settlement_with_root`. Same fields as settlement
/// plus a trailing 32-byte transcript root, under the v2 domain.
pub fn serialize_settlement_with_root(s: &Settlement, transcript_root: &[u8; 32]) -> Vec<u8> {
    let id = address_to_bytes32(&s.tunnel_id).expect("valid tunnel id");
    let mut out = Vec::with_capacity(DOMAIN_SETTLEMENT_V2.len() + 32 + 32 + 32);
    out.extend_from_slice(DOMAIN_SETTLEMENT_V2);
    out.extend_from_slice(&id);
    out.extend_from_slice(&u64_to_be_bytes(s.party_a_balance));
    out.extend_from_slice(&u64_to_be_bytes(s.party_b_balance));
    out.extend_from_slice(&u64_to_be_bytes(s.final_nonce));
    out.extend_from_slice(&u64_to_be_bytes(s.timestamp));
    out.extend_from_slice(transcript_root);
    out
}

pub struct HtlcLock {
    pub tunnel_id: String,
    pub payment_hash: [u8; 32],
    pub amount: u64,
    pub sender: String,
    pub receiver: String,
    pub expiry_ms: u64,
}

/// Mirrors `tunnel::serialize_htlc_lock`.
/// Order: domain, id, payment_hash, amount, sender, receiver, expiry_ms.
pub fn serialize_htlc_lock(h: &HtlcLock) -> Vec<u8> {
    let id = address_to_bytes32(&h.tunnel_id).expect("valid tunnel id");
    let sender = address_to_bytes32(&h.sender).expect("valid sender");
    let receiver = address_to_bytes32(&h.receiver).expect("valid receiver");
    let mut out = Vec::with_capacity(DOMAIN_HTLC_LOCK.len() + 32 * 4 + 16);
    out.extend_from_slice(DOMAIN_HTLC_LOCK);
    out.extend_from_slice(&id);
    out.extend_from_slice(&h.payment_hash);
    out.extend_from_slice(&u64_to_be_bytes(h.amount));
    out.extend_from_slice(&sender);
    out.extend_from_slice(&receiver);
    out.extend_from_slice(&u64_to_be_bytes(h.expiry_ms));
    out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p rustbench wire`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/rustbench/src/engine/wire.rs
git commit -m "feat(rustbench): byte-exact wire serializers"
```

---

### Task 5: Commit-reveal commitment

**Files:**
- Modify: `tools/rustbench/src/engine/commitment.rs`
- Test: in-file `#[cfg(test)]` module.

**Interfaces:**
- Consumes: `engine::crypto::blake2b256`, `engine::codec::u64_to_be_bytes`.
- Produces:
  - `pub const DOMAIN_COMMIT_REVEAL: &[u8]`
  - `pub const MIN_SALT_LEN: usize = 16`
  - `pub fn compute_commitment(value: &[u8], salt: &[u8]) -> Result<[u8; 32], String>` — errors if `salt.len() < 16`.
  - `pub fn verify_commitment(commitment: &[u8; 32], value: &[u8], salt: &[u8]) -> bool`
  - `pub fn combine_reveals(value_a: &[u8], salt_a: &[u8], value_b: &[u8], salt_b: &[u8]) -> [u8; 32]`

- [ ] **Step 1: Write the failing test (golden COMMITMENT / SEED)**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commitment_matches_golden() {
        // valueA = [7], saltA = 1..16
        let salt_a: Vec<u8> = (1u8..=16).collect();
        let got = compute_commitment(&[7], &salt_a).unwrap();
        assert_eq!(hex::encode(got),
            "9c5d7de7c93e176f232424794b460112bbc1e3edad6af9da200a121e7033f9f9");
        assert!(verify_commitment(&got, &[7], &salt_a));
    }

    #[test]
    fn short_salt_is_rejected_on_commit() {
        assert!(compute_commitment(&[7], &[0u8; 15]).is_err());
    }

    #[test]
    fn combine_reveals_matches_golden_seed() {
        let salt_a: Vec<u8> = (1u8..=16).collect();
        let salt_b: Vec<u8> = (17u8..=32).collect();
        let seed = combine_reveals(&[7], &salt_a, &[42], &salt_b);
        assert_eq!(hex::encode(seed),
            "3783060fbc9a59b74485cbd081355de0b78609fb6db3b76d0c97f937dac4b795");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p rustbench commitment`
Expected: FAIL (functions not defined).

- [ ] **Step 3: Write the implementation (above the test module)**

```rust
//! Two-party commit-reveal, byte-identical to `commitment.ts` / `randomness.move`.
//!
//!   commitment = blake2b256(DOMAIN || lp(value) || lp(salt))
//!   seed       = blake2b256(DOMAIN || lp(value_a) || lp(salt_a) || lp(value_b) || lp(salt_b))
//! where lp(x) = u64be(len(x)) || x.

use crate::engine::codec::u64_to_be_bytes;
use crate::engine::crypto::blake2b256;

pub const DOMAIN_COMMIT_REVEAL: &[u8] = b"sui_tunnel::randomness::commit_reveal";
pub const MIN_SALT_LEN: usize = 16;

fn push_length_prefixed(out: &mut Vec<u8>, x: &[u8]) {
    out.extend_from_slice(&u64_to_be_bytes(x.len() as u64));
    out.extend_from_slice(x);
}

fn hash_commitment(value: &[u8], salt: &[u8]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(DOMAIN_COMMIT_REVEAL.len() + 16 + value.len() + salt.len());
    buf.extend_from_slice(DOMAIN_COMMIT_REVEAL);
    push_length_prefixed(&mut buf, value);
    push_length_prefixed(&mut buf, salt);
    blake2b256(&buf)
}

/// Commit path. Enforces the >= 16-byte salt, mirroring `create_commitment`.
pub fn compute_commitment(value: &[u8], salt: &[u8]) -> Result<[u8; 32], String> {
    if salt.len() < MIN_SALT_LEN {
        return Err(format!("salt must be >= {MIN_SALT_LEN} bytes, got {}", salt.len()));
    }
    Ok(hash_commitment(value, salt))
}

/// Verify path. Never errors on short salt — returns false, mirroring
/// `verify_commitment`, which never aborts.
pub fn verify_commitment(commitment: &[u8; 32], value: &[u8], salt: &[u8]) -> bool {
    &hash_commitment(value, salt) == commitment
}

/// Combine two reveals into a 32-byte joint seed neither party can bias.
pub fn combine_reveals(value_a: &[u8], salt_a: &[u8], value_b: &[u8], salt_b: &[u8]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(DOMAIN_COMMIT_REVEAL.len() + 32 + value_a.len() + salt_a.len() + value_b.len() + salt_b.len());
    buf.extend_from_slice(DOMAIN_COMMIT_REVEAL);
    push_length_prefixed(&mut buf, value_a);
    push_length_prefixed(&mut buf, salt_a);
    push_length_prefixed(&mut buf, value_b);
    push_length_prefixed(&mut buf, salt_b);
    blake2b256(&buf)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p rustbench commitment`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/rustbench/src/engine/commitment.rs
git commit -m "feat(rustbench): commit-reveal commitment primitives"
```

---

### Task 6: Golden-vector integration test (the parity gate)

**Files:**
- Create: `tools/rustbench/tests/golden.rs`
- Create: `tools/rustbench/tests/vectors/core.json`

**Interfaces:**
- Consumes: the full `rustbench::engine` public API.
- Produces: a single integration test asserting the whole engine reproduces the captured `golden.gen.ts` output. This is the gate the design's parity strategy (1) requires.

- [ ] **Step 1: Capture the canonical vectors into `tests/vectors/core.json`**

```json
{
  "_source": "sui-tunnel-ts/src/core/golden.gen.ts via `node --import tsx src/core/golden.gen.ts`",
  "state_update": "7375695f74756e6e656c3a3a73746174655f75706461746500000000000000000000000000000000000000000000000000000000000000ab0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20000000000000002a00000000499602d200000000000003e800000000000007d0",
  "settlement": "7375695f74756e6e656c3a3a736574746c656d656e7400000000000000000000000000000000000000000000000000000000000000ab00000000000003e800000000000007d0000000000000002b00000000499602d2",
  "settlement_v2": "7375695f74756e6e656c3a3a736574746c656d656e745f763200000000000000000000000000000000000000000000000000000000000000ab00000000000003e800000000000007d0000000000000002b00000000499602d20102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  "htlc_lock": "7375695f74756e6e656c3a3a68746c635f6c6f636b00000000000000000000000000000000000000000000000000000000000000ab0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2000000000000001f400000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000bb000000000098967f",
  "commitment": "9c5d7de7c93e176f232424794b460112bbc1e3edad6af9da200a121e7033f9f9",
  "seed": "3783060fbc9a59b74485cbd081355de0b78609fb6db3b76d0c97f937dac4b795",
  "blake2b_hello": "324dcf027dd4a30a932c441f365a25e86b173defa4b8e58948253471b81b72cf",
  "pk_a": "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664",
  "sig_a": "6941c8ba5bd00d2695d5edd6d33e3fb3e46a83685e09717382b0b0b82246726323a6abc9bec1ebb8535bb3100a03bf5205e7ce5c898f8d071916c4c795ac180b"
}
```

- [ ] **Step 2: Write the failing integration test**

```rust
//! Whole-engine parity gate against the captured golden.gen.ts vectors.
//! No external deps beyond hex; the JSON is read as a raw string and the fields
//! matched by name to keep the test dependency-free.

use rustbench::engine::commitment::{combine_reveals, compute_commitment};
use rustbench::engine::crypto::{blake2b256, keypair_from_secret};
use rustbench::engine::wire::{
    serialize_htlc_lock, serialize_settlement, serialize_settlement_with_root,
    serialize_state_update, HtlcLock, Settlement, StateUpdate,
};

fn field(json: &str, key: &str) -> String {
    let needle = format!("\"{key}\"");
    let start = json.find(&needle).expect("key present");
    let after = &json[start + needle.len()..];
    let colon = after.find(':').unwrap();
    let q1 = after[colon..].find('"').unwrap() + colon + 1;
    let q2 = after[q1..].find('"').unwrap() + q1;
    after[q1..q2].to_string()
}

#[test]
fn engine_reproduces_all_golden_vectors() {
    let json = include_str!("vectors/core.json");
    let sh: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);

    let su = serialize_state_update(&StateUpdate {
        tunnel_id: "0xab".into(), state_hash: sh, nonce: 42,
        timestamp: 1234567890, party_a_balance: 1000, party_b_balance: 2000,
    });
    assert_eq!(hex::encode(&su), field(json, "state_update"));

    let settle = serialize_settlement(&Settlement {
        tunnel_id: "0xab".into(), party_a_balance: 1000, party_b_balance: 2000,
        final_nonce: 43, timestamp: 1234567890,
    });
    assert_eq!(hex::encode(&settle), field(json, "settlement"));

    let settle_v2 = serialize_settlement_with_root(&Settlement {
        tunnel_id: "0xab".into(), party_a_balance: 1000, party_b_balance: 2000,
        final_nonce: 43, timestamp: 1234567890,
    }, &sh);
    assert_eq!(hex::encode(&settle_v2), field(json, "settlement_v2"));

    let htlc = serialize_htlc_lock(&HtlcLock {
        tunnel_id: "0xab".into(), payment_hash: sh, amount: 500,
        sender: "0xaa".into(), receiver: "0xbb".into(), expiry_ms: 9999999,
    });
    assert_eq!(hex::encode(&htlc), field(json, "htlc_lock"));

    let salt_a: Vec<u8> = (1u8..=16).collect();
    let salt_b: Vec<u8> = (17u8..=32).collect();
    assert_eq!(hex::encode(compute_commitment(&[7], &salt_a).unwrap()), field(json, "commitment"));
    assert_eq!(hex::encode(combine_reveals(&[7], &salt_a, &[42], &salt_b)), field(json, "seed"));
    assert_eq!(hex::encode(blake2b256(b"hello")), field(json, "blake2b_hello"));

    let secret: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let kp = keypair_from_secret(&secret);
    assert_eq!(hex::encode(kp.public_key()), field(json, "pk_a"));
    assert_eq!(hex::encode(kp.sign(&su)), field(json, "sig_a"));
}
```

- [ ] **Step 3: Run test to verify it fails, then passes**

Run: `cargo test -p rustbench --test golden`
Expected: PASS (the unit tests from Tasks 2–5 already cover the pieces; this asserts them together against the vendored file). If anything is RED, a serializer diverged — fix the serializer, never the vector.

- [ ] **Step 4: Run the whole suite + clippy**

Run: `cargo test -p rustbench && cargo clippy -p rustbench -- -D warnings`
Expected: PASS, no warnings.

- [ ] **Step 5: Commit**

```bash
git add tools/rustbench/tests
git commit -m "test(rustbench): whole-engine golden parity gate"
```

---

## Follow-on plans (roadmap — not in this plan)

This plan delivers the parity-gated engine core. The remaining build-order steps each become their own plan, written once their predecessor lands (and after reading the source each depends on):

1. **Plan 2 — blackjack moves + offchain + local channel + single-match driver.** Port `sui-tunnel-ts/src/core/distributedTunnel.ts` per-move loop and `src/protocol/blackjack.ts` move sequence; in-memory transport pair; synthetic offchain tunnel id; one match runs end-to-end and its settlement root cross-checks against the TS engine (`tools/loadbench/src/match.ts` is the reference driver). Needs no infra.
2. **Plan 3 — swarm fleet (rayon CPU path) + resources + report.** First ceiling TPS number, comparable to `bun run bench --offchain --channel local --game blackjack`.
3. **Plan 4 — latency mode (p50/p99).**
4. **Plan 5 — relay channel.** tokio IO path; mirror `backend/tunnel-manager/src/mp/protocol.rs`. Needs `bun run stack`.
5. **Plan 6 — onchain anchor.** Crib `backend/tunnel-manager/src/sui.rs`: PTB `create_and_fund` open + `close_cooperative_with_root` settle on the localnet. Needs `bun run stack`. Completes the full matrix for blackjack.
