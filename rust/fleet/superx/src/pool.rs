//! Disjoint per-swarm Sui account + gas pool.
//!
//! A `sui-sponsored` run needs every concurrent swarm to fund its opens from an
//! account and gas set that no sibling swarm touches — otherwise their PTBs
//! contend on the same gas coins and owned objects and serialize on-chain. The
//! daemon loads an [`AccountPool`] from `--accounts-file` and hands each run a
//! disjoint slice via [`AccountPool::allocate`], returning them with
//! [`AccountPool::release`] once the run ends so later runs reuse the same slots.

use std::path::Path;
use std::sync::Mutex;

/// One swarm's isolated Sui funding identity: the funder `address`, the `key_ref`
/// that signs its opens, and the gas/stake coin objects reserved for it. Kept
/// disjoint across concurrently-running swarms so their PTBs never contend on the
/// same coins.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SuiAccountSlot {
    pub address: String,
    pub key_ref: String,
    pub gas_coin_ids: Vec<String>,
}

/// A fixed set of [`SuiAccountSlot`]s handed out disjointly to runs. Allocation
/// removes slots from the free set; release returns them for reuse. Cheap to
/// share behind an `Arc` — the `Mutex` only guards the small free-list vector.
pub struct AccountPool {
    free: Mutex<Vec<SuiAccountSlot>>,
}

impl AccountPool {
    /// Build a pool over a fixed slot set (every slot initially free).
    pub fn from_slots(slots: Vec<SuiAccountSlot>) -> Self {
        Self {
            free: Mutex::new(slots),
        }
    }

    /// Load a pool from a JSON file: a top-level array of [`SuiAccountSlot`]
    /// objects. Returns a human-readable error string (never panics) so the
    /// daemon can abort startup with a clear message on a missing/malformed file.
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|err| format!("read accounts file {}: {err}", path.display()))?;
        let slots: Vec<SuiAccountSlot> = serde_json::from_str(&text)
            .map_err(|err| format!("parse accounts file {}: {err}", path.display()))?;
        Ok(Self::from_slots(slots))
    }

    /// Number of slots currently free (not checked out by a run).
    pub fn available(&self) -> usize {
        self.free.lock().expect("account pool lock poisoned").len()
    }

    /// Check out `n` disjoint free slots. Errors (leaving the pool untouched) when
    /// fewer than `n` remain, reporting the shortfall. `n == 0` yields an empty
    /// vec so memory-anchor runs (which never allocate) are a natural no-op.
    pub fn allocate(&self, n: u64) -> Result<Vec<SuiAccountSlot>, String> {
        let mut free = self.free.lock().expect("account pool lock poisoned");
        let want = n as usize;
        if free.len() < want {
            return Err(format!(
                "account pool exhausted: need {want}, have {}",
                free.len()
            ));
        }
        // Take from the tail: order is irrelevant to disjointness and avoids
        // shifting the remaining free entries.
        let at = free.len() - want;
        Ok(free.split_off(at))
    }

    /// Return previously-allocated slots to the free set so a later run can reuse
    /// them. Called by the daemon when a run reaches a terminal state.
    pub fn release(&self, slots: Vec<SuiAccountSlot>) {
        self.free
            .lock()
            .expect("account pool lock poisoned")
            .extend(slots);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(n: u32) -> SuiAccountSlot {
        SuiAccountSlot {
            address: format!("0xaddr{n}"),
            key_ref: format!("suiprivkey1{n}"),
            gas_coin_ids: vec![format!("0xcoin{n}")],
        }
    }

    fn pool_of_three() -> AccountPool {
        AccountPool::from_slots(vec![slot(0), slot(1), slot(2)])
    }

    #[test]
    fn allocate_hands_out_disjoint_slots_until_exhausted_then_reuses_on_release() {
        let pool = pool_of_three();
        assert_eq!(pool.available(), 3);

        let first = pool.allocate(2).expect("two of three available");
        assert_eq!(first.len(), 2);
        assert_eq!(pool.available(), 1);
        // The two checked-out slots are distinct identities.
        assert_ne!(first[0], first[1]);

        // Only one slot left: a second allocation of two cannot be covered, and it
        // must not partially drain the pool.
        assert!(pool.allocate(2).is_err());
        assert_eq!(pool.available(), 1);

        // Releasing the first allocation makes the slots reusable...
        pool.release(first.clone());
        assert_eq!(pool.available(), 3);

        // ...so the previously-failing allocation now succeeds.
        let second = pool.allocate(2).expect("released slots are reusable");
        assert_eq!(second.len(), 2);
        assert_eq!(pool.available(), 1);
    }

    #[test]
    fn allocate_zero_is_a_noop_and_shortfall_reports_the_gap() {
        let pool = pool_of_three();
        assert!(pool.allocate(0).expect("zero always succeeds").is_empty());
        assert_eq!(pool.available(), 3);

        let err = pool.allocate(4).expect_err("cannot cover four of three");
        assert!(
            err.contains('4') && err.contains('3'),
            "shortfall message should name need and have: {err}"
        );
    }

    #[test]
    fn load_parses_a_json_slot_array() {
        let path = std::env::temp_dir().join(format!(
            "fleet-superx-accounts-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(
            &path,
            r#"[{"address":"0xa","key_ref":"k","gas_coin_ids":["0xc1","0xc2"]}]"#,
        )
        .expect("write accounts file");

        let pool = AccountPool::load(&path).expect("valid accounts file loads");
        assert_eq!(pool.available(), 1);
        let got = pool.allocate(1).expect("one slot available");
        assert_eq!(
            got[0].gas_coin_ids,
            vec!["0xc1".to_string(), "0xc2".to_string()]
        );

        let _ = std::fs::remove_file(&path);
    }
}
