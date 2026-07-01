//! Server-side arena admission counter (ADR-0023 + ADR-0005 co-location).
//!
//! Production seat-fill is **pure on-demand and co-located** ([`crate::fleet::colocated`]): the bot's
//! play task is spawned at `arena.join`, on the user's instance, from a shared reservation recipe
//! seeded at allocate. This pool's only remaining role is the **per-instance concurrency ceiling**
//! ([`BotPool::admit_arena`]/[`BotPool::release_arena`], config `FLEET_COLOCATED_COUNT`). The former
//! `/v1/fleet` warm-pool + on-demand-reserve machinery (external bots registering over a WebSocket,
//! then being reserved/notified) was removed with the co-location cutover — the arena no longer
//! reserves from a pool; it spawns the bot directly where the user lands.

pub mod arena_anchor;
pub mod arena_opener;
pub mod bus_transport;
pub mod colocated;

use std::sync::Mutex;

/// Per-instance arena admission ceiling. Internally synchronized so it lives as a shared `AppState`
/// field used through `Arc<AppState>` with `&self`.
#[derive(Default)]
pub struct BotPool {
    /// Live co-located arena bot tasks on THIS instance: incremented at `arena.join` when a bot is
    /// spawned, decremented when its match ends. Bounds per-instance fan-out.
    arena_inflight: Mutex<u64>,
}

impl BotPool {
    /// Admit one co-located arena bot on this instance if under `cap`. `true` reserves a slot (release
    /// with [`BotPool::release_arena`] when the match ends); `false` at capacity. Per-instance
    /// backpressure for the join-time spawn; total fan-out is `cap × instances`.
    pub fn admit_arena(&self, cap: u32) -> bool {
        let mut n = self.arena_inflight.lock().unwrap();
        if *n >= cap as u64 {
            return false;
        }
        *n += 1;
        true
    }

    /// Release a slot claimed by [`BotPool::admit_arena`] when the arena match ends.
    pub fn release_arena(&self) {
        let mut n = self.arena_inflight.lock().unwrap();
        *n = n.saturating_sub(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Admission is bounded by the cap, and releasing a finished match frees a slot for the next join.
    #[test]
    fn admit_bounds_by_cap_and_release_frees_a_slot() {
        let pool = BotPool::default();
        assert!(pool.admit_arena(2), "first within cap");
        assert!(pool.admit_arena(2), "second within cap");
        assert!(!pool.admit_arena(2), "third exceeds cap");
        pool.release_arena();
        assert!(pool.admit_arena(2), "a freed slot admits again");
    }

    // Releasing with nothing in flight must floor at zero, never underflow.
    #[test]
    fn release_never_underflows() {
        let pool = BotPool::default();
        pool.release_arena();
        assert!(pool.admit_arena(1), "counter floored at 0");
    }
}
