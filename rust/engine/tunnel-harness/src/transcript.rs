//! Typed, append-only record of committed tunnel transitions, plus pure
//! transforms and pluggable export codecs. Independent of the anchor: recording
//! is a side effect; settlement never reads it.

use crate::Seat;
use serde::{Deserialize, Serialize};
use serde_big_array::BigArray;
use std::collections::HashSet;
use std::fmt;
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
    DuplicateNonce { nonce: u64 },
    NonMonotonicNonce { previous: u64, nonce: u64 },
}

impl fmt::Display for TranscriptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
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

/// blake2b256 over the node domain and the two child hashes. Shared by the whole-tree
/// `transcript_root` and the streaming `StreamingMerkleRoot` so the two can never drift.
fn merkle_node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(TRANSCRIPT_NODE_DOMAIN.len() + 64);
    bytes.extend_from_slice(TRANSCRIPT_NODE_DOMAIN);
    bytes.extend_from_slice(left);
    bytes.extend_from_slice(right);
    blake2b256(&bytes)
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
            .map(|pair| merkle_node(&pair[0], &pair[1]))
            .collect();
    }
    level[0]
}

/// Streaming O(log N) computation of `transcript_root`. Folds leaves via a binary-counter
/// carry (`carry[k]` = root of the perfect subtree over 2^k leaves); `root()` finalizes
/// with the SAME odd-level zero-leaf padding as `transcript_root`, so its output is
/// byte-identical. Holds at most ⌈log2 N⌉ hashes, never the leaves.
///
/// NOT a Merkle Mountain Range: MMR bag-the-peaks and a naive one-op-per-level fold both
/// produce the wrong root under this padding (see the N=5 golden vector).
#[derive(Clone, Debug, Default)]
pub struct StreamingMerkleRoot {
    carry: Vec<Option<[u8; 32]>>,
    count: u64,
}

impl StreamingMerkleRoot {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, leaf: [u8; 32]) {
        self.count += 1;
        let mut node = leaf;
        let mut level = 0;
        loop {
            if level == self.carry.len() {
                self.carry.push(Some(node));
                return;
            }
            match self.carry[level].take() {
                None => {
                    self.carry[level] = Some(node);
                    return;
                }
                Some(existing) => {
                    node = merkle_node(&existing, &node);
                    level += 1;
                }
            }
        }
    }

    pub fn root(&self) -> [u8; 32] {
        if self.count == 0 {
            return ZERO_ROOT;
        }
        // Fold the occupied carries low→high. Before combining a carry at `level`, lift
        // the accumulator up to that level with zero-leaf pads (the odd-level padding),
        // then combine (earlier subtree left, accumulator right).
        let mut acc: Option<([u8; 32], usize)> = None;
        for (level, slot) in self.carry.iter().enumerate() {
            let Some(node) = slot else { continue };
            match acc {
                None => acc = Some((*node, level)),
                Some((mut current, mut cur_level)) => {
                    while cur_level < level {
                        current = merkle_node(&current, &ZERO_ROOT);
                        cur_level += 1;
                    }
                    acc = Some((merkle_node(node, &current), level + 1));
                }
            }
        }
        acc.expect("count > 0 implies at least one carry").0
    }
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

    /// The settlement Merkle root over the recording. Default recomputes it from the
    /// snapshot; streaming recorders override to return an incrementally-maintained root
    /// so they need not retain the entries.
    fn transcript_root(&self, tunnel_id: &str) -> Result<[u8; 32], TranscriptError> {
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

/// Bounded-RAM recorder for the arena bot: folds each entry's leaf into a streaming
/// Merkle accumulator and drops the entry. Holds O(log N) hash state, never the entries —
/// the bot only needs the root (`arena_anchor` ignores `transcript_entries`), so
/// `snapshot()` is empty and the root is served by `transcript_root()`. Needs `tunnel_id`
/// at construction because the leaf commits to the tunnel-scoped `state_update`.
#[derive(Clone)]
pub struct StreamingRootRecorder {
    tunnel_id: String,
    state: Arc<Mutex<StreamingRecorderState>>,
}

struct StreamingRecorderState {
    acc: StreamingMerkleRoot,
    last_nonce: Option<u64>,
}

impl StreamingRootRecorder {
    pub fn new(tunnel_id: impl Into<String>) -> Self {
        Self {
            tunnel_id: tunnel_id.into(),
            state: Arc::new(Mutex::new(StreamingRecorderState {
                acc: StreamingMerkleRoot::new(),
                last_nonce: None,
            })),
        }
    }
}

impl<M> TranscriptRecorder<M> for StreamingRootRecorder {
    fn record(&self, entry: TranscriptEntry<M>) -> Result<(), TranscriptError> {
        let mut st = self.state.lock().expect("recorder mutex");
        if let Some(previous) = st.last_nonce {
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
        let leaf = transcript_leaf(&self.tunnel_id, &entry);
        st.acc.push(leaf);
        st.last_nonce = Some(entry.nonce);
        Ok(())
    }

    /// Retains no entries; the root is served by `transcript_root()`.
    fn snapshot(&self) -> Transcript<TranscriptEntry<M>> {
        Transcript::from_entries(Vec::new())
    }

    fn transcript_root(&self, tunnel_id: &str) -> Result<[u8; 32], TranscriptError> {
        debug_assert_eq!(
            tunnel_id, self.tunnel_id,
            "settle tunnel_id must match the recorder's construction id"
        );
        Ok(self.state.lock().expect("recorder mutex").acc.root())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Seat;
    use tunnel_core::crypto::blake2b256;
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

    #[test]
    fn streaming_root_matches_whole_tree_for_all_sizes() {
        for n in [0usize, 1, 2, 3, 4, 5, 6, 7, 8, 15, 16, 17, 31, 100, 1000] {
            let leaves: Vec<[u8; 32]> =
                (0..n).map(|i| blake2b256(&(i as u64).to_le_bytes())).collect();
            let mut acc = StreamingMerkleRoot::new();
            for l in &leaves {
                acc.push(*l);
            }
            assert_eq!(
                acc.root(),
                transcript_root(&leaves),
                "streaming root diverged at n={n}"
            );
        }
    }

    #[test]
    fn streaming_root_holds_log_n_state_at_100k() {
        let mut acc = StreamingMerkleRoot::new();
        let mut leaves = Vec::with_capacity(100_000);
        for i in 0..100_000u64 {
            let leaf = blake2b256(&i.to_le_bytes());
            leaves.push(leaf);
            acc.push(leaf);
        }
        // ceil(log2(100000)) = 17 → the carry vec never exceeds 17 levels.
        assert!(acc.carry.len() <= 17, "carry levels {} exceed 17", acc.carry.len());
        assert_eq!(acc.root(), transcript_root(&leaves));
    }

    #[test]
    fn streaming_recorder_root_equals_canonical_whole_buffer_root() {
        let tunnel_id = "0x5555555555555555555555555555555555555555555555555555555555555555";
        let entries = vec![
            parity_entry(1, 90, 110, 0x11, 0x22),
            parity_entry(2, 95, 105, 0x33, 0x44),
            parity_entry(3, 80, 120, 0x55, 0x66),
        ];
        let rec = StreamingRootRecorder::new(tunnel_id);
        for e in &entries {
            TranscriptRecorder::<()>::record(&rec, e.clone()).unwrap();
        }
        let whole = Transcript::from_entries(entries)
            .canonical_root_for_tunnel(tunnel_id)
            .unwrap();
        let streamed = TranscriptRecorder::<()>::transcript_root(&rec, tunnel_id).unwrap();
        assert_eq!(streamed, whole);
        // Same fixture root as the whole-buffer path (TS parity vector).
        assert_eq!(
            hex::encode(streamed),
            "1d96600288a81c30db9384dca7be6d9904bfeb062efd28b9d74bd1fb2d61df30"
        );
    }

    #[test]
    fn streaming_recorder_rejects_duplicate_and_non_monotonic_nonce() {
        let rec = StreamingRootRecorder::new("0xabc");
        TranscriptRecorder::<()>::record(&rec, parity_entry(2, 95, 105, 0x33, 0x44)).unwrap();
        assert_eq!(
            TranscriptRecorder::<()>::record(&rec, parity_entry(2, 1, 1, 0, 0)),
            Err(TranscriptError::DuplicateNonce { nonce: 2 })
        );
        assert_eq!(
            TranscriptRecorder::<()>::record(&rec, parity_entry(1, 1, 1, 0, 0)),
            Err(TranscriptError::NonMonotonicNonce {
                previous: 2,
                nonce: 1
            })
        );
    }

    #[test]
    fn streaming_recorder_snapshot_is_empty() {
        let rec = StreamingRootRecorder::new("0xabc");
        TranscriptRecorder::<()>::record(&rec, parity_entry(1, 90, 110, 0x11, 0x22)).unwrap();
        let snap: Transcript<TranscriptEntry<()>> = rec.snapshot();
        assert!(snap.entries().is_empty());
        assert!(TranscriptRecorder::<()>::records_transcript(&rec));
    }
}
