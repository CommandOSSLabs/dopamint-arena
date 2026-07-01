//! Typed, append-only record of committed tunnel transitions, plus pure
//! transforms and pluggable export codecs. Independent of the anchor: recording
//! is a side effect; settlement never reads it.

use crate::Seat;
use serde::{Deserialize, Serialize};
use serde_big_array::BigArray;
use std::collections::HashSet;
use std::fmt;
use std::marker::PhantomData;
use std::sync::{Arc, Mutex};
use tunnel_core::crypto::blake2b256;
use tunnel_core::wire::{serialize_state_update, StateUpdate};

const TRANSCRIPT_LEAF_DOMAIN: &[u8] = b"sui_tunnel::transcript::leaf";
const TRANSCRIPT_NODE_DOMAIN: &[u8] = b"sui_tunnel::transcript::node";
const ZERO_ROOT: [u8; 32] = [0u8; 32];

/// One committed transition: the MOVE frame fused with its matching ACK's
/// `sig_responder`. Every field except `sig_responder` comes from the MOVE;
/// the ACK contributes only the responder signature. The typed `mv` lets serde
/// render the real move on export.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranscriptEntry<M> {
    pub nonce: u64,
    pub by: Seat,
    pub mv: M,
    pub state_hash: [u8; 32],
    pub timestamp: u64,
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    #[serde(with = "BigArray")]
    pub sig_proposer: [u8; 64],
    #[serde(with = "BigArray")]
    pub sig_responder: [u8; 64],
}

/// Immutable recording. `filter`/`map` return new values; nothing is mutated.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Transcript<E> {
    entries: Vec<E>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TranscriptError {
    MissingTunnelId,
    DuplicateNonce { nonce: u64 },
    NonMonotonicNonce { previous: u64, nonce: u64 },
}

impl fmt::Display for TranscriptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingTunnelId => {
                write!(f, "transcript recorder needs a tunnel id before recording")
            }
            Self::DuplicateNonce { nonce } => {
                write!(f, "transcript has duplicate entries for nonce {nonce}")
            }
            Self::NonMonotonicNonce { previous, nonce } => {
                write!(
                    f,
                    "transcript nonce {nonce} does not advance after nonce {previous}"
                )
            }
        }
    }
}

impl std::error::Error for TranscriptError {}

impl<E> Transcript<E> {
    pub fn from_entries(entries: Vec<E>) -> Self {
        Self { entries }
    }

    pub fn entries(&self) -> &[E] {
        &self.entries
    }

    pub fn filter(&self, mut pred: impl FnMut(&E) -> bool) -> Transcript<E>
    where
        E: Clone,
    {
        Transcript {
            entries: self.entries.iter().filter(|e| pred(e)).cloned().collect(),
        }
    }

    pub fn map<T>(&self, f: impl FnMut(&E) -> T) -> Transcript<T> {
        Transcript {
            entries: self.entries.iter().map(f).collect(),
        }
    }
}

impl<M> Transcript<TranscriptEntry<M>> {
    pub fn root_for_tunnel(&self, tunnel_id: &str) -> [u8; 32] {
        let leaves = self
            .entries
            .iter()
            .map(|entry| transcript_leaf(tunnel_id, entry))
            .collect::<Vec<_>>();
        transcript_root(&leaves)
    }

    pub fn canonical_root_for_tunnel(&self, tunnel_id: &str) -> Result<[u8; 32], TranscriptError> {
        let mut seen = HashSet::new();
        let mut canonical_leaves = Vec::new();
        let mut previous_nonce = None;

        for entry in &self.entries {
            let leaf = transcript_leaf(tunnel_id, entry);
            if seen.contains(&entry.nonce) {
                return Err(TranscriptError::DuplicateNonce { nonce: entry.nonce });
            }

            if let Some(previous) = previous_nonce {
                if entry.nonce <= previous {
                    return Err(TranscriptError::NonMonotonicNonce {
                        previous,
                        nonce: entry.nonce,
                    });
                }
            }

            seen.insert(entry.nonce);
            canonical_leaves.push(leaf);
            previous_nonce = Some(entry.nonce);
        }

        Ok(transcript_root(&canonical_leaves))
    }
}

pub fn transcript_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return ZERO_ROOT;
    }
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            level.push(ZERO_ROOT);
        }
        level = level
            .chunks_exact(2)
            .map(|pair| transcript_node(pair[0], pair[1]))
            .collect();
    }
    level[0]
}

fn transcript_node(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(TRANSCRIPT_NODE_DOMAIN.len() + left.len() + right.len());
    bytes.extend_from_slice(TRANSCRIPT_NODE_DOMAIN);
    bytes.extend_from_slice(&left);
    bytes.extend_from_slice(&right);
    blake2b256(&bytes)
}

pub fn transcript_leaf<M>(tunnel_id: &str, entry: &TranscriptEntry<M>) -> [u8; 32] {
    let update = StateUpdate {
        tunnel_id: tunnel_id.to_string(),
        state_hash: entry.state_hash,
        nonce: entry.nonce,
        timestamp: entry.timestamp,
        party_a_balance: entry.party_a_balance,
        party_b_balance: entry.party_b_balance,
    };
    let message = serialize_state_update(&update);
    let (sig_a, sig_b) = match entry.by {
        Seat::A => (&entry.sig_proposer, &entry.sig_responder),
        Seat::B => (&entry.sig_responder, &entry.sig_proposer),
    };
    let mut bytes = Vec::with_capacity(
        TRANSCRIPT_LEAF_DOMAIN.len() + message.len() + sig_a.len() + sig_b.len(),
    );
    bytes.extend_from_slice(TRANSCRIPT_LEAF_DOMAIN);
    bytes.extend_from_slice(&message);
    bytes.extend_from_slice(sig_a);
    bytes.extend_from_slice(sig_b);
    blake2b256(&bytes)
}

/// Pluggable export format (mirrors the repo's `FrameCodec` family: a trait, not
/// an enum, so it is open for extension). Pure: takes `&self`, returns a new value.
pub trait TranscriptCodec {
    type Output;
    type Error;

    fn serialize<E: Serialize>(&self, t: &Transcript<E>) -> Result<Self::Output, Self::Error>;
}

/// Human-readable JSON (`{"entries":[...]}`).
pub struct JsonTranscriptCodec;

impl TranscriptCodec for JsonTranscriptCodec {
    type Output = String;
    type Error = serde_json::Error;

    fn serialize<E: Serialize>(&self, t: &Transcript<E>) -> Result<String, serde_json::Error> {
        serde_json::to_string(t)
    }
}

/// Canonical, byte-stable BCS.
pub struct BcsTranscriptCodec;

impl TranscriptCodec for BcsTranscriptCodec {
    type Output = Vec<u8>;
    type Error = bcs::Error;

    fn serialize<E: Serialize>(&self, t: &Transcript<E>) -> Result<Vec<u8>, bcs::Error> {
        bcs::to_bytes(t)
    }
}

/// Compact postcard.
pub struct PostcardTranscriptCodec;

impl TranscriptCodec for PostcardTranscriptCodec {
    type Output = Vec<u8>;
    type Error = postcard::Error;

    fn serialize<E: Serialize>(&self, t: &Transcript<E>) -> Result<Vec<u8>, postcard::Error> {
        postcard::to_allocvec(t)
    }
}

/// A typed recording tap. Held by the driver as a generic param (static dispatch);
/// never `dyn` (the typed entry makes the trait non-object-safe). `record` takes
/// `&self` plus interior mutability so one instance can be shared.
pub trait TranscriptRecorder<M> {
    /// `false` for sinks that intentionally discard entries. Anchors that require
    /// a transcript root must fail closed instead of silently settling an empty root.
    fn records_transcript(&self) -> bool {
        true
    }

    fn record(&self, entry: TranscriptEntry<M>) -> Result<(), TranscriptError>;
    fn snapshot(&self) -> Transcript<TranscriptEntry<M>>;

    /// Called once after open, before committed entries are recorded. Recorders
    /// that only keep derived root state use it to hash leaves without retaining
    /// the full entries.
    fn set_tunnel_id(&self, _tunnel_id: &str) {}

    fn canonical_root_for_tunnel(&self, tunnel_id: &str) -> Result<[u8; 32], TranscriptError> {
        self.snapshot().canonical_root_for_tunnel(tunnel_id)
    }

    /// Preprocess (filter + reshape) then serialize in one pure pass. `preprocess`
    /// returns `None` to drop an entry. The raw recording is never mutated.
    fn export<C, T, F>(&self, codec: &C, preprocess: F) -> Result<C::Output, C::Error>
    where
        C: TranscriptCodec,
        F: FnMut(&TranscriptEntry<M>) -> Option<T>,
        T: Serialize,
    {
        let snapshot = self.snapshot();
        let reshaped: Vec<T> = snapshot.entries().iter().filter_map(preprocess).collect();
        codec.serialize(&Transcript::from_entries(reshaped))
    }
}

/// Shared, lock-guarded recording. One instance can be cloned to the driver
/// record path and to another consumer that exports snapshots later.
pub struct InMemoryTranscriptRecorder<M> {
    entries: Arc<Mutex<Vec<TranscriptEntry<M>>>>,
}

impl<M> Clone for InMemoryTranscriptRecorder<M> {
    fn clone(&self) -> Self {
        Self {
            entries: Arc::clone(&self.entries),
        }
    }
}

impl<M> Default for InMemoryTranscriptRecorder<M> {
    fn default() -> Self {
        Self::new()
    }
}

impl<M> InMemoryTranscriptRecorder<M> {
    pub fn new() -> Self {
        Self {
            entries: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl<M: Clone> TranscriptRecorder<M> for InMemoryTranscriptRecorder<M> {
    fn record(&self, entry: TranscriptEntry<M>) -> Result<(), TranscriptError> {
        let mut entries = self.entries.lock().expect("recorder mutex");
        if let Some(previous) = entries.last().map(|e| e.nonce) {
            if entry.nonce == previous {
                return Err(TranscriptError::DuplicateNonce { nonce: entry.nonce });
            }
            if entry.nonce < previous {
                return Err(TranscriptError::NonMonotonicNonce {
                    previous,
                    nonce: entry.nonce,
                });
            }
        }
        entries.push(entry);
        Ok(())
    }

    fn snapshot(&self) -> Transcript<TranscriptEntry<M>> {
        Transcript::from_entries(self.entries.lock().expect("recorder mutex").clone())
    }
}

/// Computes the canonical transcript root while discarding committed entries.
/// This is for settlement paths that need a root but do not archive/export the
/// transcript. Memory stays bounded by the Merkle frontier rather than move count.
pub struct RootOnlyTranscriptRecorder<M> {
    state: Arc<Mutex<RootOnlyState>>,
    _move: PhantomData<fn(M)>,
}

impl<M> Clone for RootOnlyTranscriptRecorder<M> {
    fn clone(&self) -> Self {
        Self {
            state: Arc::clone(&self.state),
            _move: PhantomData,
        }
    }
}

impl<M> Default for RootOnlyTranscriptRecorder<M> {
    fn default() -> Self {
        Self::new()
    }
}

impl<M> RootOnlyTranscriptRecorder<M> {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(RootOnlyState::default())),
            _move: PhantomData,
        }
    }
}

#[derive(Default)]
struct RootOnlyState {
    tunnel_id: Option<String>,
    previous_nonce: Option<u64>,
    leaf_count: u64,
    frontier: Vec<Option<[u8; 32]>>,
}

impl RootOnlyState {
    fn push_leaf(&mut self, mut carry: [u8; 32]) {
        let mut level = 0usize;
        let mut count = self.leaf_count;
        while count & 1 == 1 {
            if level >= self.frontier.len() {
                self.frontier.push(None);
            }
            let left = self.frontier[level]
                .take()
                .expect("occupied frontier level for set count bit");
            carry = transcript_node(left, carry);
            count >>= 1;
            level += 1;
        }
        if level >= self.frontier.len() {
            self.frontier.resize(level + 1, None);
        }
        self.frontier[level] = Some(carry);
        self.leaf_count += 1;
    }

    fn root(&self) -> [u8; 32] {
        if self.leaf_count == 0 {
            return ZERO_ROOT;
        }
        let mut blocks = self
            .frontier
            .iter()
            .enumerate()
            .filter_map(|(level, hash)| hash.map(|hash| (level, hash)));
        let Some((mut current_level, mut current)) = blocks.next() else {
            return ZERO_ROOT;
        };
        for (left_level, left) in blocks {
            while current_level < left_level {
                current = transcript_node(current, ZERO_ROOT);
                current_level += 1;
            }
            current = transcript_node(left, current);
            current_level = left_level + 1;
        }
        current
    }
}

impl<M> TranscriptRecorder<M> for RootOnlyTranscriptRecorder<M> {
    fn record(&self, entry: TranscriptEntry<M>) -> Result<(), TranscriptError> {
        let mut state = self.state.lock().expect("root-only recorder mutex");
        let tunnel_id = state
            .tunnel_id
            .as_deref()
            .ok_or(TranscriptError::MissingTunnelId)?;
        if let Some(previous) = state.previous_nonce {
            if entry.nonce == previous {
                return Err(TranscriptError::DuplicateNonce { nonce: entry.nonce });
            }
            if entry.nonce < previous {
                return Err(TranscriptError::NonMonotonicNonce {
                    previous,
                    nonce: entry.nonce,
                });
            }
        }
        let leaf = transcript_leaf(tunnel_id, &entry);
        state.previous_nonce = Some(entry.nonce);
        state.push_leaf(leaf);
        Ok(())
    }

    fn snapshot(&self) -> Transcript<TranscriptEntry<M>> {
        Transcript::from_entries(Vec::new())
    }

    fn set_tunnel_id(&self, tunnel_id: &str) {
        self.state
            .lock()
            .expect("root-only recorder mutex")
            .tunnel_id = Some(tunnel_id.to_string());
    }

    fn canonical_root_for_tunnel(&self, tunnel_id: &str) -> Result<[u8; 32], TranscriptError> {
        let state = self.state.lock().expect("root-only recorder mutex");
        if state.tunnel_id.as_deref() != Some(tunnel_id) {
            return Err(TranscriptError::MissingTunnelId);
        }
        Ok(state.root())
    }
}

/// Records nothing. For drivers that do not need a transcript.
#[derive(Clone, Copy, Debug, Default)]
pub struct NullTranscriptRecorder;

impl<M> TranscriptRecorder<M> for NullTranscriptRecorder {
    fn records_transcript(&self) -> bool {
        false
    }

    fn record(&self, _entry: TranscriptEntry<M>) -> Result<(), TranscriptError> {
        Ok(())
    }

    fn snapshot(&self) -> Transcript<TranscriptEntry<M>> {
        Transcript::from_entries(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Seat;
    use tunnel_core::wire::{serialize_settlement_with_root, Settlement};

    fn entry(nonce: u64) -> TranscriptEntry<u8> {
        TranscriptEntry {
            nonce,
            by: Seat::A,
            mv: nonce as u8,
            state_hash: [nonce as u8; 32],
            timestamp: nonce * 10,
            party_a_balance: 100 - nonce,
            party_b_balance: 100 + nonce,
            sig_proposer: [1u8; 64],
            sig_responder: [2u8; 64],
        }
    }

    fn parity_entry(
        nonce: u64,
        party_a_balance: u64,
        party_b_balance: u64,
        proposer_sig_byte: u8,
        responder_sig_byte: u8,
    ) -> TranscriptEntry<()> {
        TranscriptEntry {
            nonce,
            by: Seat::A,
            mv: (),
            state_hash: std::array::from_fn(|i| i as u8 + nonce as u8),
            timestamp: 1000 + nonce,
            party_a_balance,
            party_b_balance,
            sig_proposer: [proposer_sig_byte; 64],
            sig_responder: [responder_sig_byte; 64],
        }
    }

    #[test]
    fn filter_and_map_build_new_values_without_mutating_original() {
        let t = Transcript::from_entries(vec![entry(1), entry(2), entry(3)]);
        let evens = t.filter(|e| e.nonce % 2 == 0);
        let nonces = t.map(|e| e.nonce);
        assert_eq!(evens.entries().len(), 1);
        assert_eq!(evens.entries()[0].nonce, 2);
        assert_eq!(nonces.entries(), &[1, 2, 3]);
        // original untouched
        assert_eq!(t.entries().len(), 3);
    }

    #[test]
    fn json_codec_round_trips_a_transcript() {
        let t = Transcript::from_entries(vec![entry(1), entry(2)]);
        let json = JsonTranscriptCodec.serialize(&t).unwrap();
        let back: Transcript<TranscriptEntry<u8>> = serde_json::from_str(&json).unwrap();
        assert_eq!(back.entries(), t.entries());
    }

    #[test]
    fn bcs_and_postcard_codecs_produce_decodable_bytes() {
        let t = Transcript::from_entries(vec![entry(1)]);
        let bcs_bytes = BcsTranscriptCodec.serialize(&t).unwrap();
        let pc_bytes = PostcardTranscriptCodec.serialize(&t).unwrap();
        let from_bcs: Transcript<TranscriptEntry<u8>> = bcs::from_bytes(&bcs_bytes).unwrap();
        let from_pc: Transcript<TranscriptEntry<u8>> = postcard::from_bytes(&pc_bytes).unwrap();
        assert_eq!(from_bcs.entries(), t.entries());
        assert_eq!(from_pc.entries(), t.entries());
    }

    #[test]
    fn in_memory_recorder_records_and_snapshots_in_order() {
        let rec = InMemoryTranscriptRecorder::<u8>::new();
        rec.record(entry(1)).unwrap();
        rec.record(entry(2)).unwrap();
        let snap = rec.snapshot();
        assert_eq!(
            snap.entries().iter().map(|e| e.nonce).collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn in_memory_recorder_rejects_duplicate_nonce_at_record_time() {
        let rec = InMemoryTranscriptRecorder::<u8>::new();
        rec.record(entry(1)).unwrap();

        assert_eq!(
            rec.record(entry(1)),
            Err(TranscriptError::DuplicateNonce { nonce: 1 })
        );
        assert_eq!(rec.snapshot().entries().len(), 1);
    }

    #[test]
    fn in_memory_recorder_rejects_non_monotonic_nonce_at_record_time() {
        let rec = InMemoryTranscriptRecorder::<u8>::new();
        rec.record(entry(2)).unwrap();

        assert_eq!(
            rec.record(entry(1)),
            Err(TranscriptError::NonMonotonicNonce {
                previous: 2,
                nonce: 1
            })
        );
        assert_eq!(rec.snapshot().entries().len(), 1);
    }

    #[test]
    fn transcript_root_matches_the_ts_merkle_fixture() {
        let transcript = Transcript::from_entries(vec![
            parity_entry(1, 90, 110, 0x11, 0x22),
            parity_entry(2, 95, 105, 0x33, 0x44),
            parity_entry(3, 80, 120, 0x55, 0x66),
        ]);

        let root = transcript
            .root_for_tunnel("0x5555555555555555555555555555555555555555555555555555555555555555");

        assert_eq!(
            hex::encode(root),
            "1d96600288a81c30db9384dca7be6d9904bfeb062efd28b9d74bd1fb2d61df30"
        );

        let settlement = Settlement {
            tunnel_id: "0x5555555555555555555555555555555555555555555555555555555555555555".into(),
            party_a_balance: 80,
            party_b_balance: 120,
            final_nonce: 1,
            timestamp: 2000,
        };
        assert_eq!(
            hex::encode(serialize_settlement_with_root(&settlement, &root)),
            "7375695f74756e6e656c3a3a736574746c656d656e745f7632555555555555555555555555555555555555555555555555555555555555555500000000000000500000000000000078000000000000000100000000000007d01d96600288a81c30db9384dca7be6d9904bfeb062efd28b9d74bd1fb2d61df30"
        );
    }

    #[test]
    fn canonical_root_rejects_identical_duplicate_nonces() {
        let tunnel_id = "0x5555555555555555555555555555555555555555555555555555555555555555";
        let duplicated = Transcript::from_entries(vec![
            parity_entry(1, 90, 110, 0x11, 0x22),
            parity_entry(1, 90, 110, 0x11, 0x22),
        ]);

        assert_eq!(
            duplicated.canonical_root_for_tunnel(tunnel_id),
            Err(TranscriptError::DuplicateNonce { nonce: 1 })
        );
    }

    #[test]
    fn canonical_root_rejects_same_nonce_with_different_leaf() {
        let tunnel_id = "0x5555555555555555555555555555555555555555555555555555555555555555";
        let transcript = Transcript::from_entries(vec![
            parity_entry(1, 90, 110, 0x11, 0x22),
            parity_entry(1, 90, 110, 0x99, 0x22),
        ]);

        assert_eq!(
            transcript.canonical_root_for_tunnel(tunnel_id),
            Err(TranscriptError::DuplicateNonce { nonce: 1 })
        );
    }

    #[test]
    fn canonical_root_rejects_out_of_order_nonces() {
        let tunnel_id = "0x5555555555555555555555555555555555555555555555555555555555555555";
        let transcript = Transcript::from_entries(vec![
            parity_entry(2, 95, 105, 0x33, 0x44),
            parity_entry(1, 90, 110, 0x11, 0x22),
        ]);

        assert_eq!(
            transcript.canonical_root_for_tunnel(tunnel_id),
            Err(TranscriptError::NonMonotonicNonce {
                previous: 2,
                nonce: 1
            })
        );
    }

    #[test]
    fn export_preprocess_drops_and_reshapes_then_serializes() {
        let rec = InMemoryTranscriptRecorder::<u8>::new();
        rec.record(entry(1)).unwrap();
        rec.record(entry(2)).unwrap();
        rec.record(entry(3)).unwrap();
        // keep odd nonces, project to (nonce, balances)
        let json = rec
            .export(&JsonTranscriptCodec, |e| {
                (e.nonce % 2 == 1).then_some((e.nonce, e.party_a_balance))
            })
            .unwrap();
        let back: Transcript<(u64, u64)> = serde_json::from_str(&json).unwrap();
        assert_eq!(back.entries(), &[(1, 99), (3, 97)]);
        // raw recording is untouched
        assert_eq!(rec.snapshot().entries().len(), 3);
    }

    #[test]
    fn root_only_recorder_matches_in_memory_root_without_retaining_entries() {
        let tunnel_id = "0x5555555555555555555555555555555555555555555555555555555555555555";
        let entries = vec![
            parity_entry(1, 90, 110, 0x11, 0x22),
            parity_entry(2, 95, 105, 0x33, 0x44),
            parity_entry(3, 80, 120, 0x55, 0x66),
            parity_entry(4, 70, 130, 0x77, 0x88),
            parity_entry(5, 60, 140, 0x99, 0xaa),
        ];
        let full = InMemoryTranscriptRecorder::new();
        let root_only = RootOnlyTranscriptRecorder::new();
        root_only.set_tunnel_id(tunnel_id);

        for entry in entries {
            full.record(entry.clone()).unwrap();
            root_only.record(entry).unwrap();
        }

        assert_eq!(
            root_only.canonical_root_for_tunnel(tunnel_id),
            full.canonical_root_for_tunnel(tunnel_id)
        );
        assert!(
            root_only.snapshot().entries().is_empty(),
            "root-only recorder must discard committed entries"
        );
    }

    #[test]
    fn root_only_recorder_requires_tunnel_id_before_recording() {
        let rec = RootOnlyTranscriptRecorder::<u8>::new();

        assert_eq!(rec.record(entry(1)), Err(TranscriptError::MissingTunnelId));
    }

    #[test]
    fn null_recorder_is_a_no_op() {
        let rec = NullTranscriptRecorder;
        rec.record(entry(1)).unwrap();
        let snapshot: Transcript<TranscriptEntry<u8>> = rec.snapshot();
        assert!(snapshot.entries().is_empty());
        let json = rec
            .export(&JsonTranscriptCodec, |e: &TranscriptEntry<u8>| {
                Some(e.nonce)
            })
            .unwrap();
        assert_eq!(json, "{\"entries\":[]}");
    }
}
