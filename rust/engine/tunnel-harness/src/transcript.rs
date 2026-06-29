//! Typed, append-only record of committed tunnel transitions, plus pure
//! transforms and pluggable export codecs. Independent of the anchor: recording
//! is a side effect; settlement never reads it.

use crate::Seat;
use serde::{Deserialize, Serialize};
use serde_big_array::BigArray;
use std::sync::{Arc, Mutex};

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

    pub fn map<T>(&self, mut f: impl FnMut(&E) -> T) -> Transcript<T> {
        Transcript {
            entries: self.entries.iter().map(|e| f(e)).collect(),
        }
    }
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
    fn record(&self, entry: TranscriptEntry<M>);
    fn snapshot(&self) -> Transcript<TranscriptEntry<M>>;

    /// Preprocess (filter + reshape) then serialize in one pure pass. `preprocess`
    /// returns `None` to drop an entry. The raw recording is never mutated.
    fn export<C, T, F>(&self, codec: &C, mut preprocess: F) -> Result<C::Output, C::Error>
    where
        C: TranscriptCodec,
        F: FnMut(&TranscriptEntry<M>) -> Option<T>,
        T: Serialize,
    {
        let snapshot = self.snapshot();
        let reshaped: Vec<T> = snapshot
            .entries()
            .iter()
            .filter_map(|e| preprocess(e))
            .collect();
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
    fn record(&self, entry: TranscriptEntry<M>) {
        self.entries.lock().expect("recorder mutex").push(entry);
    }

    fn snapshot(&self) -> Transcript<TranscriptEntry<M>> {
        Transcript::from_entries(self.entries.lock().expect("recorder mutex").clone())
    }
}

/// Records nothing. For drivers that do not need a transcript.
#[derive(Clone, Copy, Default)]
pub struct NullTranscriptRecorder;

impl<M> TranscriptRecorder<M> for NullTranscriptRecorder {
    fn record(&self, _entry: TranscriptEntry<M>) {}

    fn snapshot(&self) -> Transcript<TranscriptEntry<M>> {
        Transcript::from_entries(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Seat;

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
        rec.record(entry(1));
        rec.record(entry(2));
        let snap = rec.snapshot();
        assert_eq!(
            snap.entries().iter().map(|e| e.nonce).collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn export_preprocess_drops_and_reshapes_then_serializes() {
        let rec = InMemoryTranscriptRecorder::<u8>::new();
        rec.record(entry(1));
        rec.record(entry(2));
        rec.record(entry(3));
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
        rec.record(entry(1));
        let snapshot: Transcript<TranscriptEntry<u8>> = rec.snapshot();
        assert!(snapshot.entries().is_empty());
        let json = rec
            .export(&JsonTranscriptCodec, |e: &TranscriptEntry<u8>| Some(e.nonce))
            .unwrap();
        assert_eq!(json, "{\"entries\":[]}");
    }
}
