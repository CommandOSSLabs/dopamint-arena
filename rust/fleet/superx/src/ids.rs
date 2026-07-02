//! Globally-unique tunnel id namespacing across swarms and concurrent runs.

/// Interleave a swarm's local tunnels into the global address space so that
/// tunnels from sibling swarms never share an index: swarm `s` of `n` owns
/// indices `s, s+n, s+2n, …`.
pub fn swarm_global_index(swarm_index: u64, swarm_count: u64, local_index: u64) -> u64 {
    swarm_index + local_index * swarm_count.max(1)
}

/// Tunnel id folds the run id into the address namespace so concurrent runs
/// never share a tunnel id. Hex, non-zero.
pub fn tunnel_id_for(run_id: &str, global_index: u64) -> String {
    // Stable, collision-resistant: hash run_id, mix with index.
    let mut h: u64 = 1469598103934665603; // FNV offset
    for b in run_id.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    let mixed = h ^ (global_index.wrapping_add(1));
    format!("0x{:016x}{:016x}", h, mixed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn swarms_and_runs_never_collide() {
        assert_eq!(
            (0..3).map(|i| swarm_global_index(0, 2, i)).collect::<Vec<_>>(),
            vec![0, 2, 4]
        );
        assert_eq!(
            (0..3).map(|i| swarm_global_index(1, 2, i)).collect::<Vec<_>>(),
            vec![1, 3, 5]
        );
        assert_ne!(tunnel_id_for("runA", 3), tunnel_id_for("runB", 3));
        assert_ne!(tunnel_id_for("runA", 3), tunnel_id_for("runA", 4));
    }
}
