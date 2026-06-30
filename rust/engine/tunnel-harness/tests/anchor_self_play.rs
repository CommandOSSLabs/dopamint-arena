//! End-to-end: two drivers open one tunnel, play a tiny match to terminal, both
//! settle, and each recorder yields a complete typed transcript whose
//! re-serialization is byte-stable and whose moves deserialize back.

use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{
    Balances, BcsTranscriptCodec, InMemoryAnchor, InMemoryFrameTransport,
    InMemoryTranscriptRecorder, JsonTranscriptCodec, LocalSigner, MoveStrategy,
    MoveStrategyContext, PartyDriver, Protocol, ProtocolError, Seat, SeatParts, Transcript,
    TranscriptCodec, TranscriptEntry, TranscriptRecorder, TunnelContext,
};

struct Tiny;

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
struct TinyMove;

#[derive(Clone)]
struct TinyState {
    a: u64,
    b: u64,
    n: u64,
}

impl Protocol for Tiny {
    type State = TinyState;
    type Move = TinyMove;

    fn name(&self) -> &str {
        "tiny.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> TinyState {
        TinyState {
            a: ctx.initial.a,
            b: ctx.initial.b,
            n: 0,
        }
    }

    fn apply_move(
        &self,
        s: &TinyState,
        _mv: &TinyMove,
        by: Seat,
    ) -> Result<TinyState, ProtocolError> {
        let turn = if s.n % 2 == 0 { Seat::A } else { Seat::B };
        if by != turn {
            return Err(ProtocolError("wrong turn".into()));
        }
        let mut next = s.clone();
        match by {
            Seat::A => {
                next.a -= 1;
                next.b += 1;
            }
            Seat::B => {
                next.b -= 1;
                next.a += 1;
            }
        }
        next.n += 1;
        Ok(next)
    }

    fn encode_state(&self, s: &TinyState) -> Vec<u8> {
        let mut out = b"tiny".to_vec();
        out.extend_from_slice(&s.a.to_be_bytes());
        out.extend_from_slice(&s.b.to_be_bytes());
        out.extend_from_slice(&s.n.to_be_bytes());
        out
    }

    fn balances(&self, s: &TinyState) -> Balances {
        Balances { a: s.a, b: s.b }
    }

    fn is_terminal(&self, s: &TinyState) -> bool {
        s.n >= 4
    }
}

struct AlwaysMove;

impl MoveStrategy<Tiny> for AlwaysMove {
    async fn plan_move(
        &mut self,
        s: &TinyState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<TinyMove> {
        let turn = if s.n % 2 == 0 { Seat::A } else { Seat::B };
        (turn == seat && s.n < 4).then_some(TinyMove)
    }
}

fn parts(seat: Seat, secret: &[u8; 32], opponent_pk: [u8; 32]) -> SeatParts<Tiny, LocalSigner> {
    SeatParts {
        protocol: Tiny,
        signer: LocalSigner::from_secret(secret),
        opponent_pk,
        initial: Balances { a: 5, b: 5 },
        seat,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn self_play_opens_once_settles_and_records_a_complete_transcript() {
    let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let pk_a = keypair_from_secret(&secret_a).public_key();
    let pk_b = keypair_from_secret(&secret_b).public_key();
    let (ch_a, ch_b) = InMemoryFrameTransport::pair();

    let anchor = InMemoryAnchor::new();
    let rec_a = InMemoryTranscriptRecorder::<TinyMove>::new();
    let rec_b = InMemoryTranscriptRecorder::<TinyMove>::new();

    let driver_a = PartyDriver::new(
        parts(Seat::A, &secret_a, pk_b),
        AlwaysMove,
        ch_a,
        anchor.clone(),
        rec_a.clone(),
    );
    let driver_b = PartyDriver::new(
        parts(Seat::B, &secret_b, pk_a),
        AlwaysMove,
        ch_b,
        anchor.clone(),
        rec_b.clone(),
    );

    let (ra, rb) = tokio::join!(driver_a.run(100, || 1), driver_b.run(100, || 1));
    let (out_a, _) = ra.expect("seat A");
    let (out_b, _) = rb.expect("seat B");

    assert_eq!(out_a.moves, 4);
    assert_eq!(out_a.final_balances.sum(), 10);
    assert_eq!(out_a.final_balances, out_b.final_balances);

    let snap_a = rec_a.snapshot();
    assert_eq!(snap_a.entries().len(), 4);
    assert_eq!(
        snap_a.entries().iter().map(|e| e.nonce).collect::<Vec<_>>(),
        vec![1, 2, 3, 4]
    );

    let json1 = JsonTranscriptCodec.serialize(&snap_a).unwrap();
    let json2 = JsonTranscriptCodec.serialize(&rec_a.snapshot()).unwrap();
    assert_eq!(json1, json2);

    let bytes = BcsTranscriptCodec.serialize(&snap_a).unwrap();
    let back: Transcript<TranscriptEntry<TinyMove>> = bcs::from_bytes(&bytes).unwrap();
    assert_eq!(back.entries(), snap_a.entries());
    assert!(back.entries().iter().all(|e| e.mv == TinyMove));
}
