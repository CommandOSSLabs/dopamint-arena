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

/// Durable Redis-Streams queue (ADR-0029): the stream is the at-least-once log, a consumer group
/// distributes work across workers, and an un-acked entry survives a crash in the group's PEL. The
/// 229-byte header rides the stream (fields `t`=tunnel, `h`=base64 header); the full body sits under
/// a TTL key so the stream stays small. `ack` both XACKs (clears the PEL) and XDELs (so `depth` via
/// XLEN tracks the live backlog, not an ever-growing log). Crash-recovery of a *dead* worker's PEL
/// (XAUTOCLAIM) is a follow-up; the common transient path re-enqueues explicitly.
pub struct RedisSettleQueue {
    pool: fred::clients::RedisPool,
    stream: String,
    group: String,
    body_ttl_secs: i64,
}

impl RedisSettleQueue {
    pub async fn new(
        pool: fred::clients::RedisPool,
        stream: String,
        group: String,
        body_ttl_secs: i64,
    ) -> anyhow::Result<Self> {
        use fred::interfaces::StreamsInterface;
        // MKSTREAM so the group (and stream) exist before any XADD; tolerate an existing group.
        let created: Result<(), fred::error::RedisError> = pool
            .xgroup_create(stream.as_str(), group.as_str(), "$", true)
            .await;
        if let Err(e) = created {
            if !e.to_string().contains("BUSYGROUP") {
                return Err(anyhow::anyhow!("xgroup_create {stream}/{group}: {e}"));
            }
        }
        Ok(Self {
            pool,
            stream,
            group,
            body_ttl_secs,
        })
    }

    fn body_key(&self, id: &str) -> String {
        format!("settle:body:{id}")
    }
}

#[async_trait::async_trait]
impl SettleQueue for RedisSettleQueue {
    async fn enqueue(
        &self,
        tunnel_id: &str,
        header: Vec<u8>,
        body: Bytes,
    ) -> anyhow::Result<String> {
        use base64::Engine;
        use fred::interfaces::{KeysInterface, StreamsInterface};
        let h_b64 = base64::engine::general_purpose::STANDARD.encode(&header);
        let fields = vec![("t", tunnel_id.to_string()), ("h", h_b64)];
        // id `*` = server-assigned; no cap here (acked entries are XDEL'd, bounding growth).
        let id: String = self
            .pool
            .xadd(self.stream.as_str(), false, None::<()>, "*", fields)
            .await
            .map_err(|e| anyhow::anyhow!("xadd: {e}"))?;
        let _: () = self
            .pool
            .set(
                self.body_key(&id),
                body.to_vec(),
                Some(fred::types::Expiration::EX(self.body_ttl_secs)),
                None,
                false,
            )
            .await
            .map_err(|e| anyhow::anyhow!("set body: {e}"))?;
        Ok(id)
    }

    async fn claim(
        &self,
        consumer: &str,
        max: usize,
        block_ms: u64,
    ) -> anyhow::Result<Vec<QueuedSettle>> {
        use base64::Engine;
        use fred::interfaces::StreamsInterface;
        // BLOCK 0 in Redis blocks forever; map our "don't block" (0) to no BLOCK option.
        let block = (block_ms > 0).then_some(block_ms);
        let resp: fred::types::XReadResponse<String, String, String, String> = self
            .pool
            .xreadgroup_map(
                self.group.as_str(),
                consumer,
                Some(max as u64),
                block,
                false,
                self.stream.as_str(),
                ">",
            )
            .await
            .map_err(|e| anyhow::anyhow!("xreadgroup: {e}"))?;
        let mut out = Vec::new();
        if let Some(entries) = resp.get(&self.stream) {
            for (id, fields) in entries {
                let tunnel_id = fields.get("t").cloned().unwrap_or_default();
                let header = fields
                    .get("h")
                    .and_then(|h| base64::engine::general_purpose::STANDARD.decode(h).ok())
                    .unwrap_or_default();
                out.push(QueuedSettle {
                    id: id.clone(),
                    tunnel_id,
                    header,
                });
            }
        }
        Ok(out)
    }

    async fn body(&self, id: &str) -> anyhow::Result<Option<Bytes>> {
        use fred::interfaces::KeysInterface;
        let v: Option<Vec<u8>> = self
            .pool
            .get(self.body_key(id))
            .await
            .map_err(|e| anyhow::anyhow!("get body: {e}"))?;
        Ok(v.map(Bytes::from))
    }

    async fn ack(&self, ids: &[String]) -> anyhow::Result<()> {
        use fred::interfaces::{KeysInterface, StreamsInterface};
        if ids.is_empty() {
            return Ok(());
        }
        let ids_vec = ids.to_vec();
        let _: i64 = self
            .pool
            .xack(self.stream.as_str(), self.group.as_str(), ids_vec.clone())
            .await
            .map_err(|e| anyhow::anyhow!("xack: {e}"))?;
        // XDEL after XACK so XLEN reflects the live backlog (acked work leaves the stream).
        let _: i64 = self
            .pool
            .xdel(self.stream.as_str(), ids_vec)
            .await
            .map_err(|e| anyhow::anyhow!("xdel: {e}"))?;
        let body_keys: Vec<String> = ids.iter().map(|id| self.body_key(id)).collect();
        let _: i64 = self
            .pool
            .del(body_keys)
            .await
            .map_err(|e| anyhow::anyhow!("del bodies: {e}"))?;
        Ok(())
    }

    async fn depth(&self) -> anyhow::Result<u64> {
        use fred::interfaces::StreamsInterface;
        let n: u64 = self
            .pool
            .xlen(self.stream.as_str())
            .await
            .map_err(|e| anyhow::anyhow!("xlen: {e}"))?;
        Ok(n)
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

    // Docker-gated (testcontainers): exercises the real Redis-Streams impl against a live Redis,
    // pinning the consumer-group roundtrip + the XACK/XDEL depth semantics. Same gate as the other
    // store::redis tests, so it runs in CI (with Docker) and is skipped on a Docker-less laptop.
    #[tokio::test]
    async fn redis_queue_roundtrip_enqueue_claim_body_ack() {
        use testcontainers_modules::redis::Redis;
        use testcontainers_modules::testcontainers::{runners::AsyncRunner, ImageExt};

        let node = Redis::default()
            .with_tag("7.4-alpine")
            .start()
            .await
            .expect("start redis container");
        let port = node.get_host_port_ipv4(6379).await.expect("redis port");
        let url = format!("redis://127.0.0.1:{port}");
        let mut pool = None;
        for _ in 0..40 {
            if let Ok(p) = crate::store::redis::connect(&url).await {
                pool = Some(p);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let pool = pool.expect("connect to redis container within 2s");

        let q = RedisSettleQueue::new(pool, "settle:queue:test".into(), "g1".into(), 60)
            .await
            .expect("create queue + group");

        q.enqueue("0xaa", vec![1u8; 229], Bytes::from_static(b"bodyA"))
            .await
            .unwrap();
        q.enqueue("0xbb", vec![2u8; 229], Bytes::from_static(b"bodyB"))
            .await
            .unwrap();
        assert_eq!(q.depth().await.unwrap(), 2);

        let claimed = q.claim("c1", 10, 100).await.unwrap();
        assert_eq!(claimed.len(), 2, "consumer group delivers both");
        assert_eq!(claimed[0].tunnel_id, "0xaa");
        assert_eq!(
            claimed[0].header,
            vec![1u8; 229],
            "header survives the stream roundtrip"
        );
        assert_eq!(
            q.body(&claimed[0].id).await.unwrap().unwrap(),
            Bytes::from_static(b"bodyA")
        );

        let ids: Vec<String> = claimed.iter().map(|c| c.id.clone()).collect();
        q.ack(&ids).await.unwrap();
        assert_eq!(
            q.depth().await.unwrap(),
            0,
            "acked entries XDEL'd from the stream"
        );
        assert!(
            q.body(&claimed[0].id).await.unwrap().is_none(),
            "body key deleted on ack"
        );
        assert!(
            q.claim("c1", 10, 0).await.unwrap().is_empty(),
            "no new entries after ack"
        );
    }
}
