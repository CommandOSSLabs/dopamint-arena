//! Durable settle queue (ADR-0029). `/settle` validates then enqueues here and returns 202;
//! a worker pool drains it, coalescing many closes into one PTB. The 229-byte header rides the
//! queue (all the PTB needs); the full body (the Walrus archive, MBs at high `MAX_MOVES`) is
//! stored separately so the queue stays small under a 1000+ burst regardless of transcript size.
//!
//! Two impls: `RedisSettleQueue` (fred streams + consumer group, durable + crash-recoverable)
//! for production, and `InMemorySettleQueue` (a `VecDeque`) for fast, Docker-free logic tests
//! and the in-process dev path — mirroring the control-store's redis/in-memory split.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};

use axum::body::Bytes;
use tokio::sync::Mutex;

/// One queued settlement: the entry id (for ack), its tunnel, and the 229-byte header the PTB
/// builder consumes. The full body is fetched separately via `SettleQueue::body`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueuedSettle {
    pub id: String,
    pub tunnel_id: String,
    pub header: Vec<u8>,
}

#[async_trait::async_trait]
pub trait SettleQueue: Send + Sync {
    /// Enqueue a settlement; returns the entry id. Stores the full body for later archival.
    async fn enqueue(
        &self,
        tunnel_id: &str,
        header: Vec<u8>,
        body: Bytes,
    ) -> anyhow::Result<String>;
    /// Claim up to `max` pending entries for this consumer, draining everything available
    /// immediately; if none are pending, block up to `block_ms` before returning empty.
    async fn claim(
        &self,
        consumer: &str,
        max: usize,
        block_ms: u64,
    ) -> anyhow::Result<Vec<QueuedSettle>>;
    /// The archived body for a claimed entry (None if expired/missing).
    async fn body(&self, id: &str) -> anyhow::Result<Option<Bytes>>;
    /// Acknowledge entries as fully processed (removes them from the pending set + drops bodies).
    async fn ack(&self, ids: &[String]) -> anyhow::Result<()>;
    /// Approximate count of un-claimed entries — the backpressure signal ("raise S" when it grows).
    async fn depth(&self) -> anyhow::Result<u64>;
}

/// In-memory queue for tests and the single-instance dev path. Bodies are retained until `ack`
/// so a claimed-but-unprocessed entry can still be archived (and re-claimed after a crash, which
/// the in-memory impl does not simulate — that is the Redis impl's job).
#[derive(Default)]
pub struct InMemorySettleQueue {
    pending: Mutex<VecDeque<QueuedSettle>>,
    bodies: Mutex<HashMap<String, Bytes>>,
    counter: AtomicU64,
}

#[async_trait::async_trait]
impl SettleQueue for InMemorySettleQueue {
    async fn enqueue(
        &self,
        tunnel_id: &str,
        header: Vec<u8>,
        body: Bytes,
    ) -> anyhow::Result<String> {
        let id = format!("m-{}", self.counter.fetch_add(1, Ordering::Relaxed));
        self.bodies.lock().await.insert(id.clone(), body);
        self.pending.lock().await.push_back(QueuedSettle {
            id: id.clone(),
            tunnel_id: tunnel_id.to_string(),
            header,
        });
        Ok(id)
    }

    async fn claim(
        &self,
        _consumer: &str,
        max: usize,
        block_ms: u64,
    ) -> anyhow::Result<Vec<QueuedSettle>> {
        {
            let mut q = self.pending.lock().await;
            if !q.is_empty() {
                let n = max.min(q.len());
                return Ok(q.drain(..n).collect());
            }
        }
        if block_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(block_ms)).await;
            let mut q = self.pending.lock().await;
            let n = max.min(q.len());
            return Ok(q.drain(..n).collect());
        }
        Ok(Vec::new())
    }

    async fn body(&self, id: &str) -> anyhow::Result<Option<Bytes>> {
        Ok(self.bodies.lock().await.get(id).cloned())
    }

    async fn ack(&self, ids: &[String]) -> anyhow::Result<()> {
        let mut bodies = self.bodies.lock().await;
        for id in ids {
            bodies.remove(id);
        }
        Ok(())
    }

    async fn depth(&self) -> anyhow::Result<u64> {
        Ok(self.pending.lock().await.len() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn enqueue_then_claim_drains_fifo_then_body_then_ack() {
        let q = InMemorySettleQueue::default();
        q.enqueue("0xaa", vec![1u8; 229], Bytes::from_static(b"bodyA"))
            .await
            .unwrap();
        q.enqueue("0xbb", vec![2u8; 229], Bytes::from_static(b"bodyB"))
            .await
            .unwrap();
        assert_eq!(q.depth().await.unwrap(), 2);

        let claimed = q.claim("w1", 10, 0).await.unwrap();
        assert_eq!(claimed.len(), 2, "drain-all-immediately claims both");
        assert_eq!(claimed[0].tunnel_id, "0xaa", "FIFO order");
        assert_eq!(
            q.body(&claimed[0].id).await.unwrap().unwrap(),
            Bytes::from_static(b"bodyA"),
            "body retrievable after claim, before ack"
        );

        q.ack(&[claimed[0].id.clone(), claimed[1].id.clone()])
            .await
            .unwrap();
        assert_eq!(q.depth().await.unwrap(), 0);
        assert!(
            q.body(&claimed[0].id).await.unwrap().is_none(),
            "body dropped after ack"
        );
    }

    #[tokio::test]
    async fn claim_respects_max_and_leaves_remainder() {
        let q = InMemorySettleQueue::default();
        for i in 0..5u8 {
            q.enqueue("0xaa", vec![i; 229], Bytes::from_static(b"x"))
                .await
                .unwrap();
        }
        let first = q.claim("w1", 2, 0).await.unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(q.depth().await.unwrap(), 3, "remainder stays pending");
    }

    #[tokio::test]
    async fn claim_on_empty_returns_empty_without_blocking_when_block_zero() {
        let q = InMemorySettleQueue::default();
        let claimed = q.claim("w1", 10, 0).await.unwrap();
        assert!(claimed.is_empty());
    }
}
