//! A pure-observer seam for the party driver. `PartyDriver` is the single
//! provider of lifecycle events; registered `DriverObserver`s are consumers,
//! each receiving every event read-only (no control over the loop, no chaining
//! between observers). Deliberately weaker than `MoveStrategy`, which is a
//! participant. Telemetry (heartbeats) is implemented as one such observer.

use crate::{DriverOutcome, Seat};

/// Static per-run context, emitted once before the move loop.
pub struct DriverStart<'a> {
    pub tunnel_id: &'a str,
    pub our_seat: Seat,
}

/// A committed state transition (our proposal acked, or a peer move applied).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MoveCommitted {
    /// Seat that authored the committed move.
    pub by: Seat,
    /// Tunnel nonce after the commit.
    pub nonce: u64,
    /// Running count of committed moves this run (1-based).
    pub move_index: u64,
    /// Timestamp from the driver's injected clock.
    pub timestamp_ms: u64,
}

/// A passive lifecycle tap. The driver fans each event out to every observer.
/// Hooks are read-only w.r.t. the driver and must not block the move loop —
/// offload IO and mutate only the observer's own state.
pub trait DriverObserver: Send + Sync + 'static {
    fn on_started(&mut self, _start: &DriverStart<'_>) {}
    fn on_move_committed(&mut self, _ev: &MoveCommitted) {}
    fn on_finished(&mut self, _outcome: &DriverOutcome) {}
    fn on_aborted(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Balances;

    #[derive(Default)]
    struct Recorder {
        started: Vec<(String, Seat)>,
        moves: Vec<MoveCommitted>,
        finished: u64,
        aborted: u64,
    }
    impl DriverObserver for Recorder {
        fn on_started(&mut self, s: &DriverStart<'_>) {
            self.started.push((s.tunnel_id.to_string(), s.our_seat));
        }
        fn on_move_committed(&mut self, ev: &MoveCommitted) {
            self.moves.push(*ev);
        }
        fn on_finished(&mut self, _o: &DriverOutcome) {
            self.finished += 1;
        }
        fn on_aborted(&mut self) {
            self.aborted += 1;
        }
    }

    // An observer that overrides nothing must compile and no-op.
    struct Silent;
    impl DriverObserver for Silent {}

    #[test]
    fn recorder_captures_events_and_silent_is_noop() {
        let mut r = Recorder::default();
        r.on_started(&DriverStart {
            tunnel_id: "0xab",
            our_seat: Seat::A,
        });
        r.on_move_committed(&MoveCommitted {
            by: Seat::A,
            nonce: 1,
            move_index: 1,
            timestamp_ms: 10,
        });
        r.on_finished(&DriverOutcome {
            moves: 1,
            final_balances: Balances { a: 1, b: 1 },
        });
        r.on_aborted();

        assert_eq!(r.started, vec![("0xab".to_string(), Seat::A)]);
        assert_eq!(r.moves.len(), 1);
        assert_eq!(r.moves[0].nonce, 1);
        assert_eq!(r.finished, 1);
        assert_eq!(r.aborted, 1);

        // Silent uses defaults — just prove it satisfies the trait.
        let mut s = Silent;
        s.on_aborted();
    }
}
