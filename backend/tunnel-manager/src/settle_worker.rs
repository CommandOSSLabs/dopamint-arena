//! Settle-worker pool (ADR-0029): drains the durable queue, coalesces a claim into one batched
//! PTB, and on success records the close + archives to Walrus + publishes the proof event. The
//! chain submission is behind the `BatchSettler` trait so the loop is testable with a fake — no
//! node required. Idempotency: a tunnel settles at most once (dedup within a claim + a
//! closed-registry re-check), an already-closed tunnel is treated as done, a genuine rejection is
//! dead-lettered, and a transient (rate-limit) is re-queued for a later attempt.

use std::sync::Arc;

use crate::settle_queue::{QueuedSettle, SettleQueue};
use crate::state::TunnelStatus;
use crate::store::{Bus, ControlStore};
use crate::sui::{CloseArgs, CloseError};
use crate::walrus::WalrusClient;

/// The chain-submission seam: submit a batch of closes as one PTB (retry-by-split inside),
/// returning one result per input close, in order. `SuiSettler` is the production impl; tests
/// inject a fake. Keeps the worker free of any direct fullnode dependency.
#[async_trait::async_trait]
pub trait BatchSettler: Send + Sync {
    async fn settle_batch(&self, closes: Vec<CloseArgs>) -> Vec<Result<String, CloseError>>;
}

#[async_trait::async_trait]
impl BatchSettler for crate::sui::SuiSettler {
    async fn settle_batch(&self, closes: Vec<CloseArgs>) -> Vec<Result<String, CloseError>> {
        self.submit_close_batch(closes).await
    }
}

/// Everything a worker needs; cloned per spawned worker (all handles are cheap).
#[derive(Clone)]
pub struct SettleWorkerDeps {
    pub queue: Arc<dyn SettleQueue>,
    pub settler: Arc<dyn BatchSettler>,
    pub control: Arc<dyn ControlStore>,
    pub walrus: WalrusClient,
    pub bus: Arc<dyn Bus>,
}

/// Run one worker forever: claim → settle batch → record/archive/ack. `flush_ms` is only the
/// empty-queue block (not an artificial batching delay — a non-empty claim drains immediately).
pub async fn run_settle_worker(
    deps: SettleWorkerDeps,
    consumer: String,
    batch_max: usize,
    flush_ms: u64,
) {
    // Backpressure alarm (ADR-0029): a queue that keeps growing means we're settling faster than
    // the chain finalizes — the signal to raise S (settle less often) or add workers/nodes.
    const BACKPRESSURE_WARN: u64 = 10_000;
    loop {
        match drain_once(&deps, &consumer, batch_max, flush_ms).await {
            Ok(n) if n > 0 => {
                if let Ok(depth) = deps.queue.depth().await {
                    if depth > BACKPRESSURE_WARN {
                        tracing::warn!(
                            depth,
                            "settle queue backlog growing — raise S or add settle workers/nodes"
                        );
                    }
                }
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(consumer = %consumer, error = %e, "settle worker drain failed");
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
    }
}

/// One claim→submit→record cycle. Returns the number of closes submitted (0 if the queue was
/// empty). Separated out so tests can drive it deterministically without the infinite loop.
pub(crate) async fn drain_once(
    deps: &SettleWorkerDeps,
    consumer: &str,
    batch_max: usize,
    flush_ms: u64,
) -> anyhow::Result<usize> {
    let claimed = deps.queue.claim(consumer, batch_max, flush_ms).await?;
    if claimed.is_empty() {
        return Ok(0);
    }

    // Build the submit set: parse each header, drop duplicates within the claim, and skip any
    // tunnel the registry already shows closed (idempotent — a redelivered or racing settle).
    let mut work: Vec<(QueuedSettle, CloseArgs)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for q in claimed {
        let dup = !seen.insert(q.tunnel_id.clone());
        let already_closed =
            deps.control.get_tunnel_status(&q.tunnel_id).await == Some(TunnelStatus::Closed);
        if dup || already_closed {
            deps.queue.ack(std::slice::from_ref(&q.id)).await?;
            continue;
        }
        match crate::routes::close_args_from_settle_header(&q.header) {
            Ok(ca) => work.push((q, ca)),
            Err(e) => {
                tracing::warn!(tunnel_id = %q.tunnel_id, error = %e, "settle: unparseable header, dead-lettering");
                dead_letter(deps, &q.tunnel_id, &e).await;
                deps.queue.ack(std::slice::from_ref(&q.id)).await?;
            }
        }
    }
    if work.is_empty() {
        return Ok(0);
    }

    let closes: Vec<CloseArgs> = work.iter().map(|(_, c)| c.clone()).collect();
    let n = closes.len();
    let results = deps.settler.settle_batch(closes).await;

    let mut to_ack: Vec<String> = Vec::new();
    for ((q, close), res) in work.into_iter().zip(results) {
        match res {
            Ok(digest) => {
                deps.control
                    .set_tunnel_status(&close.tunnel_id, TunnelStatus::Closed)
                    .await;
                archive_and_publish(deps, &close, &q.id, &digest).await;
                to_ack.push(q.id);
            }
            Err(CloseError::Rejected(msg)) => {
                // Permanent: ack so the bad settle never loops. NOTE (ADR-0029 known gap): a settle
                // that already LANDED but whose registry update was lost re-aborts `ETunnelClosed`
                // here and is dead-lettered as a false alarm — fund-safe (the tunnel IS closed), the
                // indexer still has the proof; mapping that abort back to success is a follow-up.
                tracing::warn!(tunnel_id = %close.tunnel_id, error = %msg, "settle rejected; dead-lettering");
                dead_letter(deps, &close.tunnel_id, &msg).await;
                to_ack.push(q.id);
            }
            Err(CloseError::Transient { .. }) => {
                // Node busy after GovernedRpc's own retries: re-queue intact for a later worker,
                // then ack the original entry (so Redis's pending-list doesn't also redeliver it).
                let body = deps
                    .queue
                    .body(&q.id)
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                let _ = deps
                    .queue
                    .enqueue(&close.tunnel_id, q.header.clone(), body)
                    .await;
                to_ack.push(q.id);
            }
        }
    }
    deps.queue.ack(&to_ack).await?;
    Ok(n)
}

/// Archive the body to Walrus and publish the proof on `explorer:proofs` (the FE/indexer's fast
/// path; the indexer also derives the close from chain, so a publish failure is not fatal).
async fn archive_and_publish(
    deps: &SettleWorkerDeps,
    close: &CloseArgs,
    entry_id: &str,
    digest: &str,
) {
    let root_hex = format!("0x{}", hex::encode(&close.transcript_root));
    let (blob_id, proof_url) = match deps.queue.body(entry_id).await {
        Ok(Some(body)) => deps
            .walrus
            .upload_transcript(body)
            .await
            .unwrap_or_else(|e| {
                tracing::error!(%digest, error = %e, "walrus archival failed");
                (String::new(), String::new())
            }),
        _ => (String::new(), String::new()),
    };
    deps.control
        .push_recent_event(crate::routes::settled_event(
            &close.tunnel_id,
            close.party_a_balance,
            close.party_b_balance,
            &root_hex,
            digest,
            close.timestamp,
            &proof_url,
        ))
        .await;
    if !blob_id.is_empty() {
        let proof_msg = serde_json::json!({
            "txDigest": digest,
            "walrusBlobId": blob_id,
            "proofUrl": proof_url,
        })
        .to_string();
        deps.bus.publish_raw("explorer:proofs", proof_msg).await;
    }
}

/// Publish a failed-settlement signal so a genuinely-rejected settle is visible (not silently
/// dropped). The co-signed bytes are still archived/queryable; this just flags the rejection.
async fn dead_letter(deps: &SettleWorkerDeps, tunnel_id: &str, reason: &str) {
    let msg = serde_json::json!({ "tunnelId": tunnel_id, "reason": reason }).to_string();
    deps.bus.publish_raw("settle:failed", msg).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settle_queue::InMemorySettleQueue;
    use crate::store::memory::{InMemoryControlStore, LocalBus};
    use axum::body::Bytes;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// A `BatchSettler` whose per-tunnel verdict is scripted, and which records the batch sizes it
    /// was asked to settle (to prove coalescing actually happens).
    struct FakeBatchSettler {
        verdicts: Mutex<HashMap<String, CloseError>>, // tunnel -> error to return (else Ok)
        batch_sizes: Mutex<Vec<usize>>,
    }
    impl FakeBatchSettler {
        fn new() -> Self {
            Self {
                verdicts: Mutex::new(HashMap::new()),
                batch_sizes: Mutex::new(Vec::new()),
            }
        }
        fn reject(&self, tunnel: &str) {
            self.verdicts
                .lock()
                .unwrap()
                .insert(tunnel.into(), CloseError::Rejected("poison".into()));
        }
        fn transient_once(&self, tunnel: &str) {
            self.verdicts.lock().unwrap().insert(
                tunnel.into(),
                CloseError::Transient {
                    msg: "429".into(),
                    retry_after: None,
                },
            );
        }
    }
    #[async_trait::async_trait]
    impl BatchSettler for FakeBatchSettler {
        async fn settle_batch(&self, closes: Vec<CloseArgs>) -> Vec<Result<String, CloseError>> {
            self.batch_sizes.lock().unwrap().push(closes.len());
            let mut v = self.verdicts.lock().unwrap();
            closes
                .iter()
                .map(|c| match v.remove(&c.tunnel_id) {
                    Some(e) => Err(e),
                    None => Ok("0xdigest".to_string()),
                })
                .collect()
        }
    }

    fn header_for(tunnel_hex_suffix: u8) -> Vec<u8> {
        // A minimal valid 229-byte settle header (version 0x01); only the layout matters here.
        let mut h = vec![0u8; 229];
        h[0] = 0x01;
        h[32] = tunnel_hex_suffix; // last byte of the 32-byte tunnel id
        h
    }
    fn tunnel_id_for(suffix: u8) -> String {
        format!("0x{}{:02x}", "00".repeat(31), suffix)
    }

    fn deps_with(
        settler: Arc<dyn BatchSettler>,
    ) -> (
        SettleWorkerDeps,
        Arc<InMemorySettleQueue>,
        Arc<InMemoryControlStore>,
    ) {
        let queue = Arc::new(InMemorySettleQueue::default());
        let control = Arc::new(InMemoryControlStore::default());
        let deps = SettleWorkerDeps {
            queue: queue.clone(),
            settler,
            control: control.clone(),
            walrus: WalrusClient::noop(),
            bus: Arc::new(LocalBus::new("test".into())),
        };
        (deps, queue, control)
    }

    #[tokio::test]
    async fn drains_a_batch_closes_registry_and_acks() {
        let fake = Arc::new(FakeBatchSettler::new());
        let (deps, queue, control) = deps_with(fake.clone());
        for s in 1..=3u8 {
            queue
                .enqueue(&tunnel_id_for(s), header_for(s), Bytes::from_static(b"x"))
                .await
                .unwrap();
        }
        let n = drain_once(&deps, "w1", 16, 0).await.unwrap();
        assert_eq!(n, 3, "all three submitted in one batch");
        assert_eq!(
            fake.batch_sizes.lock().unwrap().as_slice(),
            &[3],
            "coalesced into ONE batch"
        );
        assert_eq!(queue.depth().await.unwrap(), 0, "all acked, queue drained");
        assert_eq!(
            control.get_tunnel_status(&tunnel_id_for(1)).await,
            Some(TunnelStatus::Closed)
        );
    }

    #[tokio::test]
    async fn rejected_settle_is_dead_lettered_and_acked_not_looped() {
        let fake = Arc::new(FakeBatchSettler::new());
        fake.reject(&tunnel_id_for(2));
        let (deps, queue, control) = deps_with(fake.clone());
        for s in 1..=3u8 {
            queue
                .enqueue(&tunnel_id_for(s), header_for(s), Bytes::from_static(b"x"))
                .await
                .unwrap();
        }
        drain_once(&deps, "w1", 16, 0).await.unwrap();
        assert_eq!(
            queue.depth().await.unwrap(),
            0,
            "rejected entry is acked, not requeued"
        );
        assert_eq!(
            control.get_tunnel_status(&tunnel_id_for(1)).await,
            Some(TunnelStatus::Closed),
            "the good ones still settle"
        );
        assert_eq!(
            control.get_tunnel_status(&tunnel_id_for(2)).await,
            None,
            "the poison one is NOT marked closed"
        );
    }

    #[tokio::test]
    async fn transient_settle_is_requeued_then_succeeds() {
        let fake = Arc::new(FakeBatchSettler::new());
        fake.transient_once(&tunnel_id_for(1)); // first attempt 429, then Ok
        let (deps, queue, control) = deps_with(fake.clone());
        queue
            .enqueue(&tunnel_id_for(1), header_for(1), Bytes::from_static(b"x"))
            .await
            .unwrap();
        drain_once(&deps, "w1", 16, 0).await.unwrap();
        assert_eq!(
            queue.depth().await.unwrap(),
            1,
            "transient re-queued, not lost"
        );
        // Second pass: verdict consumed, now settles.
        drain_once(&deps, "w1", 16, 0).await.unwrap();
        assert_eq!(queue.depth().await.unwrap(), 0);
        assert_eq!(
            control.get_tunnel_status(&tunnel_id_for(1)).await,
            Some(TunnelStatus::Closed)
        );
    }

    #[tokio::test]
    async fn already_closed_tunnel_is_skipped_idempotently() {
        let fake = Arc::new(FakeBatchSettler::new());
        let (deps, queue, control) = deps_with(fake.clone());
        control
            .set_tunnel_status(&tunnel_id_for(1), TunnelStatus::Closed)
            .await;
        queue
            .enqueue(&tunnel_id_for(1), header_for(1), Bytes::from_static(b"x"))
            .await
            .unwrap();
        let n = drain_once(&deps, "w1", 16, 0).await.unwrap();
        assert_eq!(n, 0, "nothing submitted — already closed");
        assert_eq!(queue.depth().await.unwrap(), 0, "but the entry is acked");
        assert!(
            fake.batch_sizes.lock().unwrap().is_empty(),
            "settler never called"
        );
    }

    // A valid 229-byte settle body for a 2-byte tunnel suffix, plus the tunnel id the handler will
    // parse from it (so the path matches). Lets the e2e mint many distinct settlements.
    fn settle_body(suffix: u16) -> (String, Bytes) {
        let mut b = vec![0u8; 229];
        b[0] = 0x01;
        b[31] = (suffix >> 8) as u8;
        b[32] = (suffix & 0xff) as u8;
        let tunnel_id = format!("0x{}", hex::encode(&b[1..33]));
        (tunnel_id, Bytes::from(b))
    }

    // END-TO-END (ADR-0029): fire a burst of 200 settlements through the real `/settle` HTTP
    // handler into a 4-worker pool. Proves the whole solution: every request is accepted (202) with
    // no node call, the workers COALESCE them into multi-close batches, a transient (429) is retried
    // not lost, a genuine rejection is isolated (dead-lettered, never blocks its batch-mates), and
    // every good settlement ends up closed exactly once — i.e. a fleet burst is absorbed instead of
    // tripping the fullnode rate limit.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn e2e_burst_through_handler_settles_with_batching_retry_and_isolation() {
        use std::time::Duration;

        let state = crate::routes::test_support::test_state();
        let queue = state.settle_queue.clone();

        const N: u16 = 200;
        const POISON: u16 = 7; // always rejected on-chain
        const FLAKY: u16 = 9; // 429 on first attempt, then succeeds

        let fake = Arc::new(FakeBatchSettler::new());
        fake.reject(&settle_body(POISON).0);
        fake.transient_once(&settle_body(FLAKY).0);

        let deps = SettleWorkerDeps {
            queue: queue.clone(),
            settler: fake.clone(),
            control: state.control.clone(),
            walrus: WalrusClient::noop(),
            bus: state.bus.clone(),
        };
        let workers: Vec<_> = (0..4)
            .map(|i| tokio::spawn(run_settle_worker(deps.clone(), format!("w{i}"), 128, 20)))
            .collect();

        // Ingest: every settle is accepted immediately (202), no chain RPC on the request path.
        for s in 0..N {
            let (tid, body) = settle_body(s);
            let resp = crate::routes::settle(
                axum::extract::State(state.clone()),
                axum::extract::Path(tid),
                body,
            )
            .await;
            assert_eq!(
                resp.status(),
                axum::http::StatusCode::ACCEPTED,
                "settle {s} accepted"
            );
        }

        // Drain: wait (bounded) for the workers to clear the queue, including the flaky requeue.
        let mut drained = false;
        for _ in 0..300 {
            if queue.depth().await.unwrap() == 0 {
                drained = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(80)).await; // settle any in-flight ack
        assert!(
            drained && queue.depth().await.unwrap() == 0,
            "queue fully drained"
        );

        // Every good settlement is closed exactly once; the poison one is not.
        let mut closed = 0usize;
        for s in 0..N {
            if state.control.get_tunnel_status(&settle_body(s).0).await
                == Some(TunnelStatus::Closed)
            {
                closed += 1;
            }
        }
        assert_eq!(closed, (N as usize) - 1, "all but the poison settle closed");
        assert_eq!(
            state
                .control
                .get_tunnel_status(&settle_body(POISON).0)
                .await,
            None,
            "poison settle is isolated, never marked closed"
        );
        assert_eq!(
            state.control.get_tunnel_status(&settle_body(FLAKY).0).await,
            Some(TunnelStatus::Closed),
            "the transient settle was retried to success, not dropped"
        );

        // Coalescing actually happened — this is the fleet-scale lever, not 200 single submits.
        let sizes = fake.batch_sizes.lock().unwrap().clone();
        let max_batch = sizes.iter().copied().max().unwrap_or(0);
        let total_submitted: usize = sizes.iter().sum();
        assert!(
            max_batch > 1,
            "settles were coalesced into multi-close PTBs (max batch {max_batch})"
        );
        assert!(
            sizes.len() < N as usize,
            "fewer PTB submissions ({}) than settlements ({N}) — batching reduced chain calls",
            sizes.len()
        );
        // (total_submitted ≥ N because the flaky one is submitted twice; a useful sanity bound.)
        assert!(total_submitted >= N as usize);

        for w in workers {
            w.abort();
        }
    }
}
