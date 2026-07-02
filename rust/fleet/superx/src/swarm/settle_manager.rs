//! Per-swarm settle barrier + two-seat pairing + wave batching.
//!
//! Each tunnel's `settle()` deposits one seat's [`TunnelSettleRequest`] here and
//! parks on a shared result. The manager holds every request behind a barrier
//! until the play phase completes — i.e. all `2 * expected_tunnels` seats have
//! deposited — then drains the pairs in [`SettleWaveGate`] cohorts, submitting
//! both halves per tunnel through the inner anchor and fanning the one shared
//! [`SettledTunnel`] back to both waiting seats. Mirrors the pairing/notify
//! ordering of the bench `BenchSubmitter` (`rust/fleet/bench/src/party_driver.rs`)
//! but keyed per `tunnel_id` for a whole swarm instead of one tunnel.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{oneshot, Mutex, Notify};
use tokio::task::JoinSet;
use tunnel_harness::{Seat, SettledTunnel, SettlementMode, TunnelAnchorError, TunnelSettleRequest};

use crate::swarm::anchor::InnerAnchor;
use crate::swarm::gates::SettleWaveGate;

type SettleResult = Result<SettledTunnel, TunnelAnchorError>;
type SharedSettleResult = Arc<SettleResult>;

/// Both seats' halves for one tunnel plus the parked waiters. The `result` latch
/// makes settlement idempotent: a late or duplicate submit gets the shared result
/// instead of re-submitting.
#[derive(Default)]
struct PairSlot {
    request_a: Option<TunnelSettleRequest>,
    request_b: Option<TunnelSettleRequest>,
    result: Option<SharedSettleResult>,
    waiters: Vec<oneshot::Sender<SharedSettleResult>>,
}

struct SettleState {
    pairs: HashMap<String, PairSlot>,
    /// Seats deposited so far. The barrier releases at `expected_seats`.
    deposited: u64,
    /// Set when the pipeline abandons the settle barrier (stop/deadline/failure).
    /// The drain then proceeds on whatever has deposited: complete pairs settle,
    /// lone seats resolve with an "incomplete at drain" error so no seat parks
    /// forever waiting for a partner that will never arrive.
    forced: bool,
}

pub struct SettleManager {
    inner: Arc<InnerAnchor>,
    /// `2 * expected_tunnels`: the barrier holds until every seat has deposited.
    expected_seats: u64,
    wave: Arc<SettleWaveGate>,
    settlement_mode: SettlementMode,
    state: Mutex<SettleState>,
    /// Signalled once the last seat deposits, waking the drain loop.
    barrier: Notify,
}

impl SettleManager {
    pub fn new(
        inner: Arc<InnerAnchor>,
        expected_tunnels: u64,
        wave: Arc<SettleWaveGate>,
        settlement_mode: SettlementMode,
    ) -> Arc<Self> {
        Arc::new(Self {
            inner,
            expected_seats: expected_tunnels.saturating_mul(2),
            wave,
            settlement_mode,
            state: Mutex::new(SettleState {
                pairs: HashMap::new(),
                deposited: 0,
                forced: false,
            }),
            barrier: Notify::new(),
        })
    }

    /// The settlement byte shape the inner anchor expects; the driver signs to match.
    pub fn settlement_mode(&self) -> SettlementMode {
        self.settlement_mode
    }

    /// Seats deposited so far. The pipeline polls this to detect the settle
    /// barrier release (all `2 * expected_tunnels` seats parked) so it can time
    /// the play/settle phase boundary without reaching into the drain loop.
    pub async fn deposited(&self) -> u64 {
        self.state.lock().await.deposited
    }

    /// Deposit one seat's half and park until the barrier releases and this
    /// tunnel's pair is submitted. Both seats observe the same shared result.
    pub async fn submit(&self, seat: Seat, request: TunnelSettleRequest) -> SettleResult {
        let tunnel_id = request.tunnel_id.clone();
        let (receiver, all_deposited) = {
            let mut state = self.state.lock().await;
            let slot = state.pairs.entry(tunnel_id).or_default();
            if let Some(result) = &slot.result {
                return (**result).clone();
            }
            match seat {
                Seat::A => slot.request_a = Some(request),
                Seat::B => slot.request_b = Some(request),
            }
            let (sender, receiver) = oneshot::channel();
            slot.waiters.push(sender);
            state.deposited += 1;
            let all_deposited = state.deposited >= self.expected_seats;
            (receiver, all_deposited)
        };
        if all_deposited {
            self.barrier.notify_one();
        }
        match receiver.await {
            Ok(shared) => (*shared).clone(),
            Err(_) => Err(TunnelAnchorError::Unavailable(
                "settle manager dropped before pairing".into(),
            )),
        }
    }

    /// Spawn the drain loop. Called once the play barrier releases; the loop
    /// itself waits until every seat has deposited before draining, so the caller
    /// may fire it at any point in the settle phase.
    pub fn begin_drain(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        tokio::spawn(async move { manager.drain().await });
    }

    /// Abandon the settle barrier: release the drain even though fewer than
    /// `expected_seats` have deposited. Called by the pipeline on stop/deadline or
    /// when a tunnel fails before settling, so the barrier can never fill. The
    /// drain then settles whatever complete pairs exist and errors the rest,
    /// unparking every deposited seat instead of hanging.
    pub async fn force_release(&self) {
        self.state.lock().await.forced = true;
        self.barrier.notify_one();
    }

    async fn drain(self: Arc<Self>) {
        // Barrier: park until all `2 * expected_tunnels` seats have deposited, or
        // the pipeline forces release. `notify_one` stores a permit, so a signal
        // that races ahead of the first `notified()` is not lost; the re-check
        // guards spurious wakeups.
        loop {
            {
                let state = self.state.lock().await;
                if state.deposited >= self.expected_seats || state.forced {
                    break;
                }
            }
            self.barrier.notified().await;
        }
        let tunnel_ids: Vec<String> = self.state.lock().await.pairs.keys().cloned().collect();
        let cohort = self.wave.cohort();
        // Cohort 1 stays strictly sequential: each tunnel's pair fully settles
        // before the next admits. This is the memory anchor's natural mode.
        if cohort <= 1 {
            for tunnel_id in tunnel_ids {
                self.wave.admit().await;
                self.settle_one(&tunnel_id).await;
            }
            return;
        }
        // Cohort > 1: admit each tunnel through the wave, then spawn its settle so
        // wave-admitted members overlap in flight. The `JoinSet` is held at `cohort`
        // members — draining one before admitting the next — so the wave gate and
        // cohort size together cap concurrency at the cohort. This is what lets a
        // sponsored settle PTB batch fill instead of trickling one pair at a time.
        let mut in_flight = JoinSet::new();
        for tunnel_id in tunnel_ids {
            self.wave.admit().await;
            let manager = Arc::clone(&self);
            in_flight.spawn(async move { manager.settle_one(&tunnel_id).await });
            if in_flight.len() >= cohort {
                in_flight.join_next().await;
            }
        }
        while in_flight.join_next().await.is_some() {}
    }

    async fn settle_one(&self, tunnel_id: &str) {
        let pair = {
            let mut state = self.state.lock().await;
            let Some(slot) = state.pairs.get_mut(tunnel_id) else {
                return;
            };
            if slot.result.is_some() {
                return;
            }
            match (slot.request_a.take(), slot.request_b.take()) {
                (Some(request_a), Some(request_b)) => Ok((request_a, request_b)),
                _ => Err(TunnelAnchorError::Unavailable(
                    "settle pair incomplete at drain".into(),
                )),
            }
        };
        let result: SettleResult = match pair {
            Ok((request_a, request_b)) => {
                let (result_a, result_b) =
                    tokio::join!(self.inner.settle(request_a), self.inner.settle(request_b));
                result_a.or(result_b)
            }
            Err(error) => Err(error),
        };
        self.complete(tunnel_id, result).await;
    }

    async fn complete(&self, tunnel_id: &str, result: SettleResult) {
        let shared: SharedSettleResult = Arc::new(result);
        let waiters = {
            let mut state = self.state.lock().await;
            let Some(slot) = state.pairs.get_mut(tunnel_id) else {
                return;
            };
            if slot.result.is_some() {
                return;
            }
            slot.result = Some(Arc::clone(&shared));
            std::mem::take(&mut slot.waiters)
        };
        for waiter in waiters {
            let _ = waiter.send(Arc::clone(&shared));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;
    use tunnel_core::crypto::keypair_from_secret;
    use tunnel_core::protocol_id::ProtocolId;
    use tunnel_core::wire::{serialize_settlement, Settlement};
    use tunnel_harness::{
        Balances, InMemoryAnchor, LocalSigner, Seat, SettlementMode, Signer, TunnelAnchor,
        TunnelOpenRequest, TunnelSettleRequest,
    };

    use crate::swarm::anchor::InnerAnchor;
    use crate::swarm::gates::SettleWaveGate;

    fn seat_keys(seed: u8) -> ([u8; 32], [u8; 32]) {
        let secret: [u8; 32] = std::array::from_fn(|i| i as u8 + seed);
        let public = keypair_from_secret(&secret).public_key();
        (secret, public)
    }

    fn sign_settlement(
        secret: &[u8; 32],
        tunnel_id: &str,
        a: u64,
        b: u64,
        nonce: u64,
        ts: u64,
    ) -> [u8; 64] {
        let bytes = serialize_settlement(&Settlement {
            tunnel_id: tunnel_id.into(),
            party_a_balance: a,
            party_b_balance: b,
            final_nonce: nonce,
            timestamp: ts,
        });
        LocalSigner::from_secret(secret).sign(&bytes)
    }

    fn settle_request(
        seat: Seat,
        tunnel_id: &str,
        signature: [u8; 64],
        a: u64,
        b: u64,
        nonce: u64,
        ts: u64,
    ) -> TunnelSettleRequest {
        TunnelSettleRequest {
            by: seat,
            tunnel_id: tunnel_id.into(),
            party_a_balance: a,
            party_b_balance: b,
            final_nonce: nonce,
            timestamp: ts,
            signature,
            transcript_root: None,
            transcript_entries: Vec::new(),
        }
    }

    #[tokio::test]
    async fn settle_waits_for_all_then_pairs_both_seats() {
        let (secret_a, pk_a) = seat_keys(1);
        let (secret_b, pk_b) = seat_keys(9);

        // Open the tunnel so the memory anchor knows both seats' pubkeys.
        let memory = InMemoryAnchor::default();
        let opened = memory
            .open(TunnelOpenRequest {
                protocol: ProtocolId::parse("payments.v1").unwrap(),
                party_a: pk_a,
                party_b: pk_b,
                initial: Balances { a: 100, b: 100 },
            })
            .await
            .unwrap();
        let tunnel_id = opened.tunnel_id;

        let (a, b, nonce, ts) = (120u64, 80u64, 1u64, 42u64);
        let sig_a = sign_settlement(&secret_a, &tunnel_id, a, b, nonce, ts);
        let sig_b = sign_settlement(&secret_b, &tunnel_id, a, b, nonce, ts);
        let req_a = settle_request(Seat::A, &tunnel_id, sig_a, a, b, nonce, ts);
        let req_b = settle_request(Seat::B, &tunnel_id, sig_b, a, b, nonce, ts);

        let inner = Arc::new(InnerAnchor::Memory(memory));
        let wave = SettleWaveGate::new(64, Duration::ZERO);
        let manager = SettleManager::new(inner, 1, wave, SettlementMode::Rootless);
        manager.begin_drain();

        // Seat A deposits first: the barrier must hold it until seat B arrives.
        let a_manager = Arc::clone(&manager);
        let mut a_task = tokio::spawn(async move { a_manager.submit(Seat::A, req_a).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !a_task.is_finished(),
            "seat A must block on the settle barrier until seat B deposits"
        );

        // Seat B deposits: the barrier releases and both halves pair.
        let b_manager = Arc::clone(&manager);
        let b_task = tokio::spawn(async move { b_manager.submit(Seat::B, req_b).await });

        let settled_a = tokio::time::timeout(Duration::from_secs(2), &mut a_task)
            .await
            .expect("seat A resolves once the barrier releases")
            .unwrap()
            .unwrap();
        let settled_b = tokio::time::timeout(Duration::from_secs(2), b_task)
            .await
            .expect("seat B resolves once the barrier releases")
            .unwrap()
            .unwrap();

        assert_eq!(settled_a.final_balances, Balances { a, b });
        assert_eq!(settled_a.final_balances, settled_b.final_balances);
        assert_eq!(settled_a.digest, settled_b.digest);
    }

    /// Open one tunnel on `memory` and return its id plus both signed halves.
    /// `index` seeds distinct seat keys so every tunnel in a swarm is unique.
    async fn build_tunnel(
        memory: &InMemoryAnchor,
        index: u8,
    ) -> (String, TunnelSettleRequest, TunnelSettleRequest) {
        let (secret_a, pk_a) = seat_keys(index.wrapping_mul(2).wrapping_add(1));
        let (secret_b, pk_b) = seat_keys(index.wrapping_mul(2).wrapping_add(127));
        let opened = memory
            .open(TunnelOpenRequest {
                protocol: ProtocolId::parse("payments.v1").unwrap(),
                party_a: pk_a,
                party_b: pk_b,
                initial: Balances { a: 100, b: 100 },
            })
            .await
            .unwrap();
        let tunnel_id = opened.tunnel_id;
        let (a, b, nonce, ts) = (120u64, 80u64, 1u64, 42u64);
        let sig_a = sign_settlement(&secret_a, &tunnel_id, a, b, nonce, ts);
        let sig_b = sign_settlement(&secret_b, &tunnel_id, a, b, nonce, ts);
        let req_a = settle_request(Seat::A, &tunnel_id, sig_a, a, b, nonce, ts);
        let req_b = settle_request(Seat::B, &tunnel_id, sig_b, a, b, nonce, ts);
        (tunnel_id, req_a, req_b)
    }

    /// Drive `tunnels` tunnels through a manager with the given wave and return the
    /// peak number of distinct tunnels the inner anchor saw settling at once.
    async fn drain_peak_concurrency(tunnels: u8, cohort: usize) -> usize {
        use std::collections::HashSet;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let memory = InMemoryAnchor::default();
        let mut requests = Vec::new();
        for index in 0..tunnels {
            requests.push(build_tunnel(&memory, index).await);
        }

        let active = Arc::new(std::sync::Mutex::new(HashSet::new()));
        let peak = Arc::new(AtomicUsize::new(0));
        let inner = Arc::new(InnerAnchor::SettleConcurrencyProbe {
            memory,
            active,
            peak: Arc::clone(&peak),
            hold: Duration::from_millis(40),
        });
        let wave = SettleWaveGate::new(cohort, Duration::ZERO);
        let manager = SettleManager::new(inner, tunnels as u64, wave, SettlementMode::Rootless);
        manager.begin_drain();

        let mut tasks = Vec::new();
        for (_id, req_a, req_b) in requests {
            let ma = Arc::clone(&manager);
            let mb = Arc::clone(&manager);
            tasks.push(tokio::spawn(async move { ma.submit(Seat::A, req_a).await }));
            tasks.push(tokio::spawn(async move { mb.submit(Seat::B, req_b).await }));
        }
        for task in tasks {
            tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .expect("seat settles within deadline")
                .unwrap()
                .expect("settle succeeds");
        }
        peak.load(Ordering::Acquire)
    }

    #[tokio::test]
    async fn drain_overlaps_cohort_members_in_flight() {
        // A cohort of 4 must fly 4 tunnels at once, not trickle one pair at a time.
        let peak = drain_peak_concurrency(4, 4).await;
        assert_eq!(
            peak, 4,
            "settle_cohort=4 must overlap all four tunnels in flight, saw peak {peak}"
        );
    }

    #[tokio::test]
    async fn drain_serializes_when_cohort_is_one() {
        // cohort=1 keeps exactly one tunnel in flight even though each tunnel's two
        // seat settles run concurrently under one `join!`.
        let peak = drain_peak_concurrency(4, 1).await;
        assert_eq!(
            peak, 1,
            "settle_cohort=1 must settle strictly one tunnel at a time, saw peak {peak}"
        );
    }
}
