//! One-shot pre-open barrier for `--bench-mode warmup`.
//!
//! Each initial tunnel's anchor calls [`PreOpenGate::mark_opened`] once it has
//! opened, then parks on [`PreOpenGate::wait`] until the whole fleet is open.
//! The latch is one-shot: once released it stays open, so refill tunnels opening
//! later pass straight through without blocking.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::watch;

pub(crate) struct PreOpenGate {
    opened: AtomicU64,
    target: u64,
    released_tx: watch::Sender<bool>,
}

impl PreOpenGate {
    /// A gate that releases once `target` tunnels have opened. `target == 0`
    /// starts already-released because there is nothing to wait for.
    pub(crate) fn new(target: u64) -> Arc<Self> {
        let (released_tx, _rx) = watch::channel(target == 0);
        Arc::new(Self {
            opened: AtomicU64::new(0),
            target,
            released_tx,
        })
    }

    /// Record one opened tunnel and release the gate once `target` is reached.
    pub(crate) fn mark_opened(&self) -> u64 {
        let n = self.opened.fetch_add(1, Ordering::AcqRel) + 1;
        if n >= self.target {
            let _ = self.released_tx.send_replace(true);
        }
        n
    }

    pub(crate) fn opened(&self) -> u64 {
        self.opened.load(Ordering::Acquire)
    }

    pub(crate) fn is_released(&self) -> bool {
        *self.released_tx.borrow()
    }

    /// Park until the gate releases. Returns immediately after release.
    pub(crate) async fn wait(&self) {
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

#[cfg(test)]
mod tests {
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
