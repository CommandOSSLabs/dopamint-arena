//! Admits settle submissions in bounded, spaced waves so the sponsored settle
//! PTB batch fills instead of trickling.

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

pub(crate) struct SettleWaveGate {
    cohort: usize,
    spacing: Duration,
    state: Mutex<WaveState>,
}

#[derive(Default)]
struct WaveState {
    admitted_in_wave: usize,
}

impl SettleWaveGate {
    pub(crate) fn new(cohort: usize, spacing: Duration) -> Arc<Self> {
        Arc::new(Self {
            cohort: cohort.max(1),
            spacing,
            state: Mutex::new(WaveState::default()),
        })
    }

    /// Park until this caller is admitted into a wave. The caller proceeds to its
    /// settle submission after this returns; the next wave waits `spacing`.
    pub(crate) async fn admit(&self) {
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
mod tests {
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
