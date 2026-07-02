//! Open/settle batching gates ported from `fleet-bench`.
//!
//! [`PreOpenGate`] is a one-shot pre-open barrier: each tunnel's anchor calls
//! [`PreOpenGate::mark_opened`] once it has opened, then parks on
//! [`PreOpenGate::wait`] until the whole swarm is open. The latch is one-shot:
//! once released it stays open, so refill tunnels opening later pass straight
//! through without blocking.
//!
//! [`SettleWaveGate`] admits settle submissions in bounded, spaced waves so the
//! sponsored settle PTB batch fills instead of trickling.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, Mutex, Notify};

pub struct PreOpenGate {
    opened: AtomicU64,
    target: u64,
    released_tx: watch::Sender<bool>,
    progress: Notify,
}

impl PreOpenGate {
    /// A gate that releases once `target` tunnels have opened. `target == 0`
    /// starts already-released because there is nothing to wait for.
    pub fn new(target: u64) -> Arc<Self> {
        let (released_tx, _rx) = watch::channel(target == 0);
        Arc::new(Self {
            opened: AtomicU64::new(0),
            target,
            released_tx,
            progress: Notify::new(),
        })
    }

    /// Record one opened tunnel and release the gate once `target` is reached.
    pub fn mark_opened(&self) -> u64 {
        let n = self.opened.fetch_add(1, Ordering::AcqRel) + 1;
        self.progress.notify_waiters();
        if n >= self.target {
            let _ = self.released_tx.send_replace(true);
        }
        n
    }

    pub fn opened(&self) -> u64 {
        self.opened.load(Ordering::Acquire)
    }

    /// Release the gate regardless of how many tunnels actually opened. The
    /// pipeline calls this when it abandons the open barrier (stop, deadline, or a
    /// failed open that makes `target` unreachable) so any seat still parked on
    /// [`wait`](Self::wait) proceeds instead of hanging forever.
    pub fn force_release(&self) {
        let _ = self.released_tx.send_replace(true);
    }

    pub fn is_released(&self) -> bool {
        *self.released_tx.borrow()
    }

    /// Resolves the next time any tunnel calls `mark_opened`. Used by the swarm
    /// wave loop to re-check its cohort condition without polling.
    pub async fn opened_progress(&self) {
        self.progress.notified().await;
    }

    /// Park until the gate releases. Returns immediately after release.
    pub async fn wait(&self) {
        if *self.released_tx.borrow() {
            return;
        }
        let mut rx = self.released_tx.subscribe();
        while !*rx.borrow_and_update() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
}

pub struct SettleWaveGate {
    cohort: usize,
    spacing: Duration,
    state: Mutex<WaveState>,
}

#[derive(Default)]
struct WaveState {
    admitted_in_wave: usize,
}

impl SettleWaveGate {
    pub fn new(cohort: usize, spacing: Duration) -> Arc<Self> {
        Arc::new(Self {
            cohort: cohort.max(1),
            spacing,
            state: Mutex::new(WaveState::default()),
        })
    }

    /// Park until this caller is admitted into a wave. The caller proceeds to its
    /// settle submission after this returns; the next wave waits `spacing`.
    pub async fn admit(&self) {
        let mut state = self.state.lock().await;
        if state.admitted_in_wave >= self.cohort {
            if !self.spacing.is_zero() {
                tokio::time::sleep(self.spacing).await;
            }
            state.admitted_in_wave = 0;
        }
        state.admitted_in_wave += 1;
    }
}

#[cfg(test)]
mod pre_open_gate_tests {
    use super::*;

    #[tokio::test]
    async fn releases_exactly_at_target() {
        let gate = PreOpenGate::new(3);
        assert!(!gate.is_released());
        assert_eq!(gate.mark_opened(), 1);
        assert!(!gate.is_released());
        assert_eq!(gate.mark_opened(), 2);
        assert!(!gate.is_released());
        assert_eq!(gate.mark_opened(), 3);
        assert!(gate.is_released());
    }

    #[tokio::test]
    async fn wait_unblocks_on_release() {
        let gate = PreOpenGate::new(1);
        let g = gate.clone();
        let parked = tokio::spawn(async move { g.wait().await });
        assert!(!parked.is_finished());
        gate.mark_opened();
        parked.await.unwrap();
    }

    #[tokio::test]
    async fn mark_opened_wakes_progress_waiters() {
        let gate = PreOpenGate::new(3);
        let g = gate.clone();
        let woke = tokio::spawn(async move {
            g.opened_progress().await;
        });
        tokio::task::yield_now().await;
        assert!(!woke.is_finished());
        gate.mark_opened();
        tokio::time::timeout(std::time::Duration::from_secs(1), woke)
            .await
            .expect("progress waiter must wake on mark_opened")
            .unwrap();
    }

    #[tokio::test]
    async fn late_waiter_passes_through() {
        let gate = PreOpenGate::new(1);
        gate.mark_opened();
        tokio::time::timeout(std::time::Duration::from_secs(1), gate.wait())
            .await
            .expect("late waiter must not block");
    }

    #[tokio::test]
    async fn zero_target_starts_released() {
        let gate = PreOpenGate::new(0);
        assert!(gate.is_released());
    }
}

#[cfg(test)]
mod settle_wave_gate_tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn admits_cohort_then_spaces_next_wave() {
        let gate = SettleWaveGate::new(2, Duration::from_millis(100));
        // First wave: two admits return immediately.
        tokio::time::timeout(Duration::from_millis(20), gate.admit())
            .await
            .expect("wave-1 admit 1 immediate");
        tokio::time::timeout(Duration::from_millis(20), gate.admit())
            .await
            .expect("wave-1 admit 2 immediate");
        // Third admit starts wave 2 and must wait `spacing`.
        let g = gate.clone();
        let third = tokio::spawn(async move { g.admit().await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!third.is_finished(), "must still be spacing");
        tokio::time::timeout(Duration::from_millis(150), third)
            .await
            .expect("wave 2 admits after spacing")
            .unwrap();
    }

    #[tokio::test]
    async fn partial_final_wave_never_blocks() {
        let gate = SettleWaveGate::new(5, Duration::from_millis(100));
        for _ in 0..3 {
            tokio::time::timeout(Duration::from_millis(20), gate.admit())
                .await
                .expect("partial wave admits immediately");
        }
    }
}
