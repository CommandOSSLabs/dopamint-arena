//! Redis impls of `ControlStore`, `MpStore`, and `Bus` (fred 9.x). Selected when `REDIS_CACHE_URL`
//! is set. `RedisBus` uses sharded pub/sub: SPUBLISH for cross-instance delivery, `SubscriberClient`
//! for the inbound fan-in loop.

use std::collections::HashMap;
use std::sync::RwLock;

use async_trait::async_trait;
use fred::clients::SubscriberClient;
use fred::prelude::*;
use futures::TryStreamExt;
use tokio::sync::mpsc;

use super::{Bus, ConnRef, ControlStore, MpStore};
use crate::mp::ConnId;
use crate::state::{GameStat, SessionRecord, StatsSnapshot, TunnelEvent, TunnelStatus};

const SESSION_TTL: i64 = 24 * 3600;

// Atomic dedup-then-push for the recent-events ring. SADD returns 1 only for a new digest,
// so a re-polled event (cursor restart / second indexer) never double-inserts. Newest-first
// via LPUSH; LTRIM bounds the list. `events:seen` is unbounded but tiny for a demo window
// (same accepted trade-off as stats:tunnels:active).
// KEYS[1]=events:recent KEYS[2]=events:seen  ARGV[1]=json ARGV[2]=digest ARGV[3]=cap
const PUSH_RECENT_EVENT: &str = r#"
if redis.call('SADD', KEYS[2], ARGV[2]) == 1 then
  redis.call('LPUSH', KEYS[1], ARGV[1])
  redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[3]) - 1)
  return 1
end
return 0
"#;

pub async fn connect(url: &str) -> anyhow::Result<RedisPool> {
    let config = RedisConfig::from_url(url)?;
    let pool = Builder::from_config(config).build_pool(6)?;
    pool.init().await?;
    Ok(pool)
}

// ===== ControlStore =====

pub struct RedisControlStore {
    pool: RedisPool,
}

impl RedisControlStore {
    pub fn new(pool: RedisPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ControlStore for RedisControlStore {
    async fn put_session(&self, id: &str, rec: SessionRecord) {
        let json = serde_json::to_string(&rec).unwrap();
        let res: Result<(), _> = self
            .pool
            .set(
                format!("session:{id}"),
                json,
                Some(Expiration::EX(SESSION_TTL)),
                None,
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis put_session set failed");
        }
        let res: Result<i64, _> = self
            .pool
            .incr_by(
                format!("stats:tunnels:game:{}", rec.game),
                rec.tunnels.len() as i64,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis put_session incr tunnels failed");
        }
    }

    async fn get_session(&self, id: &str) -> Option<SessionRecord> {
        let v: Option<String> = self.pool.get(format!("session:{id}")).await.ok().flatten();
        v.and_then(|j| serde_json::from_str(&j).ok())
    }

    // SADD/SREM sets so N indexers replaying events don't over-count — SCARD gives correct total.
    async fn set_tunnel_status(&self, id: &str, s: TunnelStatus) {
        let res: Result<(), _> = self
            .pool
            .set(
                format!("tunnel:{id}"),
                serde_json::to_string(&s).unwrap(),
                None,
                None,
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis set_tunnel_status set failed");
        }
        match s {
            TunnelStatus::Active => {
                let res: Result<i64, _> = self.pool.sadd("stats:tunnels:active", id).await;
                if let Err(e) = res {
                    tracing::warn!(error = %e, "redis set_tunnel_status sadd active failed");
                }
            }
            TunnelStatus::Closed => {
                let res: Result<i64, _> = self.pool.srem("stats:tunnels:active", id).await;
                if let Err(e) = res {
                    tracing::warn!(error = %e, "redis set_tunnel_status srem active failed");
                }
                let res: Result<i64, _> = self.pool.sadd("stats:tunnels:settled", id).await;
                if let Err(e) = res {
                    tracing::warn!(error = %e, "redis set_tunnel_status sadd settled failed");
                }
            }
            TunnelStatus::Created => {}
        }
    }

    async fn get_tunnel_status(&self, id: &str) -> Option<TunnelStatus> {
        let v: Option<String> = self.pool.get(format!("tunnel:{id}")).await.ok().flatten();
        v.and_then(|j| serde_json::from_str(&j).ok())
    }

    async fn add_actions(&self, game: &str, delta: u64) {
        let res: Result<i64, _> = self.pool.incr_by("stats:actions:total", delta as i64).await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis add_actions incr total failed");
        }
        let res: Result<i64, _> = self
            .pool
            .incr_by(format!("stats:actions:game:{game}"), delta as i64)
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis add_actions incr per-game failed");
        }
    }

    async fn snapshot(&self) -> StatsSnapshot {
        let total: i64 = self
            .pool
            .get("stats:actions:total")
            .await
            .ok()
            .flatten()
            .unwrap_or(0);
        let active: i64 = self.pool.scard("stats:tunnels:active").await.unwrap_or(0);
        let settled: i64 = self.pool.scard("stats:tunnels:settled").await.unwrap_or(0);

        let mut per_game: HashMap<String, GameStat> = HashMap::new();
        for (prefix, is_actions) in [
            ("stats:actions:game:", true),
            ("stats:tunnels:game:", false),
        ] {
            let keys = self.scan_keys(&format!("{prefix}*")).await;
            for key in keys {
                let v: i64 = self.pool.get(&key).await.ok().flatten().unwrap_or(0);
                let game = key.trim_start_matches(prefix).to_owned();
                let entry = per_game.entry(game).or_insert(GameStat {
                    tps: 0.0,
                    tunnels: 0,
                    total_actions: 0,
                });
                if is_actions {
                    entry.total_actions = v as u64;
                } else {
                    entry.tunnels = v as u64;
                }
            }
        }

        let recent_events = self.recent_events().await;
        StatsSnapshot {
            tps: 0.0, // filled by the broadcaster from its per-tick diff
            total_actions: total as u64,
            active_tunnels: active as u64,
            settled_tunnels: settled as u64,
            per_game,
            recent_events,
        }
    }

    async fn push_recent_event(&self, ev: TunnelEvent) {
        let json = serde_json::to_string(&ev).unwrap();
        let res: Result<i64, _> = self
            .pool
            .eval::<i64, _, _, _>(
                PUSH_RECENT_EVENT,
                vec!["events:recent".to_string(), "events:seen".to_string()],
                vec![json, ev.tx_digest.clone(), crate::store::RECENT_EVENTS_CAP.to_string()],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis push_recent_event eval failed");
        }
    }

    async fn recent_events(&self) -> Vec<TunnelEvent> {
        let raws: Vec<String> = self
            .pool
            .lrange("events:recent", 0, (crate::store::RECENT_EVENTS_CAP - 1) as i64)
            .await
            .unwrap_or_default();
        raws.iter().filter_map(|j| serde_json::from_str(j).ok()).collect()
    }

    // fred 9.4.0: ping takes no argument (cheat-sheet erroneously shows `ping::<String>(None)`).
    async fn ready(&self) -> bool {
        self.pool.ping::<String>().await.is_ok()
    }
}

impl RedisControlStore {
    // SCAN cursor loop via a single client from the pool. Game-key cardinality is tiny (~7 games),
    // so one scan per stats tick is negligible.
    async fn scan_keys(&self, pattern: &str) -> Vec<String> {
        let mut keys = Vec::new();
        let client = self.pool.next();
        let mut stream = client.scan_buffered(pattern, Some(100), None);
        loop {
            match stream.try_next().await {
                Ok(Some(key)) => {
                    if let Some(s) = key.as_str() {
                        keys.push(s.to_owned());
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!(error = %e, "redis scan_keys stream error, truncating");
                    break;
                }
            }
        }
        keys
    }
}

// ===== MpStore =====

pub struct RedisMpStore {
    pool: RedisPool,
}

impl RedisMpStore {
    pub fn new(pool: RedisPool) -> Self {
        Self { pool }
    }
}

// KEYS[1]=queue:<game> ARGV[1]=selfWaitingJson ARGV[2]=selfWallet
// Atomically: drain stale self entries, pop the front opponent, or park self.
// Returns the opponent JSON (string) or nil (false in Lua → None in Rust).
const JOIN_OR_PAIR: &str = r#"
local front = redis.call('LPOP', KEYS[1])
while front do
  local w = cjson.decode(front)
  if w.wallet ~= ARGV[2] then return front end
  front = redis.call('LPOP', KEYS[1])
end
redis.call('RPUSH', KEYS[1], ARGV[1])
return false
"#;

// Presence compare-and-delete: only remove if the stored conn id still matches.
// KEYS[1]=presence:<wallet>  ARGV[1]=conn_id string
const CLEAR_PRESENCE_IF: &str = r#"
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
else
  return 0
end
"#;

// Atomically rebuild queue:<game> excluding every entry whose wallet == ARGV[1].
// Single KEYS[1] → cluster-safe. The DEL before RPUSH means an empty result leaves no key.
// KEYS[1]=queue:<game> ARGV[1]=wallet
const LEAVE_QUEUE: &str = r#"
local items = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1])
for _, v in ipairs(items) do
  local ok, w = pcall(cjson.decode, v)
  if not ok or w.wallet ~= ARGV[1] then redis.call('RPUSH', KEYS[1], v) end
end
return 1
"#;

#[async_trait]
impl MpStore for RedisMpStore {
    async fn set_presence(&self, wallet: &str, at: ConnRef) {
        // Two keys: a lightweight conn-id key for compare-and-delete, and a full JSON mirror
        // for get_presence (cross-instance routing needs the full ConnRef).
        let res: Result<(), _> = self
            .pool
            .set(
                format!("presence:{wallet}"),
                at.conn_id.to_string(),
                None,
                None,
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis set_presence conn_id set failed");
        }
        let res: Result<(), _> = self
            .pool
            .set(
                format!("presence:ref:{wallet}"),
                serde_json::to_string(&at).unwrap(),
                None,
                None,
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis set_presence ref set failed");
        }
    }

    async fn get_presence(&self, wallet: &str) -> Option<ConnRef> {
        let v: Option<String> = self
            .pool
            .get(format!("presence:ref:{wallet}"))
            .await
            .ok()
            .flatten();
        v.and_then(|j| serde_json::from_str(&j).ok())
    }

    async fn clear_presence_if(&self, wallet: &str, conn: crate::mp::ConnId) {
        let deleted: i64 = match self
            .pool
            .eval::<i64, _, _, _>(
                CLEAR_PRESENCE_IF,
                vec![format!("presence:{wallet}")],
                vec![conn.to_string()],
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "redis clear_presence_if eval failed");
                0
            }
        };
        // Only clear the ref mirror if the primary key was removed.
        if deleted > 0 {
            let res: Result<i64, _> = self.pool.del(format!("presence:ref:{wallet}")).await;
            if let Err(e) = res {
                tracing::warn!(error = %e, "redis clear_presence_if del ref failed");
            }
        }
    }

    async fn join_or_pair(&self, game: &str, me: crate::mp::Waiting) -> Option<crate::mp::Waiting> {
        let me_json = serde_json::to_string(&me).unwrap();
        let res: Option<String> = match self
            .pool
            .eval::<Option<String>, _, _, _>(
                JOIN_OR_PAIR,
                vec![format!("queue:{game}")],
                vec![me_json, me.wallet.clone()],
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "redis join_or_pair eval failed");
                None
            }
        };
        res.and_then(|j| serde_json::from_str(&j).ok())
    }

    async fn leave_queue(&self, game: &str, wallet: &str) {
        let res: Result<i64, _> = self
            .pool
            .eval::<i64, _, _, _>(
                LEAVE_QUEUE,
                vec![format!("queue:{game}")],
                vec![wallet.to_owned()],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis leave_queue eval failed");
        }
    }

    async fn put_invite(&self, match_id: &str, inv: crate::mp::DirectedInvite) {
        let res: Result<(), _> = self
            .pool
            .set(
                format!("invite:{match_id}"),
                serde_json::to_string(&inv).unwrap(),
                Some(Expiration::EX(60)),
                None,
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis put_invite set failed");
        }
    }

    async fn take_invite(
        &self,
        match_id: &str,
        accepter: &str,
    ) -> Option<crate::mp::DirectedInvite> {
        let v: Option<String> = self
            .pool
            .get(format!("invite:{match_id}"))
            .await
            .ok()
            .flatten();
        let inv: crate::mp::DirectedInvite = v.and_then(|j| serde_json::from_str(&j).ok())?;
        if inv.to == accepter {
            let res: Result<i64, _> = self.pool.del(format!("invite:{match_id}")).await;
            if let Err(e) = res {
                tracing::warn!(error = %e, "redis take_invite del failed");
            }
            Some(inv)
        } else {
            None
        }
    }

    async fn drop_invite(&self, match_id: &str) {
        let res: Result<i64, _> = self.pool.del(format!("invite:{match_id}")).await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis drop_invite del failed");
        }
    }

    async fn put_match(&self, match_id: &str, m: crate::mp::MatchRecord) {
        let res: Result<(), _> = self
            .pool
            .set(
                format!("match:{match_id}"),
                serde_json::to_string(&m).unwrap(),
                Some(Expiration::EX(6 * 3600)),
                None,
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis put_match set failed");
        }
    }

    async fn get_match(&self, match_id: &str) -> Option<crate::mp::MatchRecord> {
        let v: Option<String> = self
            .pool
            .get(format!("match:{match_id}"))
            .await
            .ok()
            .flatten();
        v.and_then(|j| serde_json::from_str(&j).ok())
    }

    async fn set_tunnel_id(&self, match_id: &str, tunnel_id: &str) {
        if let Some(mut m) = self.get_match(match_id).await {
            m.tunnel_id = Some(tunnel_id.to_owned());
            self.put_match(match_id, m).await;
        }
    }

    async fn record_checkpoint(&self, match_id: &str, cp: crate::mp::Checkpoint) {
        if let Some(mut m) = self.get_match(match_id).await {
            if m.latest_checkpoint
                .as_ref()
                .map_or(true, |c| cp.nonce >= c.nonce)
            {
                m.latest_checkpoint = Some(cp);
                self.put_match(match_id, m).await;
            }
        }
    }
}

// ===== Bus =====

/// Wire format for cross-instance delivery over `mp:inst:<id>` sharded pub/sub channels.
#[derive(serde::Serialize, serde::Deserialize)]
struct Wire {
    conn: ConnId,
    text: String,
}

/// Redis `Bus`: local delivery hits the in-process `conns` map; remote delivery SPUBLISH-es a
/// `Wire` JSON to `mp:inst:<target.instance_id>`. Each instance runs one `SubscriberClient` that
/// fans inbound messages to local sockets.
///
/// Phase 5 wires this via `RedisBus::new(instance_id, publisher_pool)` where `instance_id` comes
/// from `INSTANCE_ID` env and `publisher_pool` is built from `REDIS_PUBSUB_URL`.
pub struct RedisBus {
    instance_id: String,
    /// Pool used for SPUBLISH. Kept separate from the cache pool (two different connection classes).
    publisher: RedisPool,
    conns: std::sync::Arc<RwLock<HashMap<ConnId, mpsc::UnboundedSender<String>>>>,
    // Holds the SubscriberClient so the connection stays alive for the lifetime of the bus.
    #[allow(dead_code)]
    _subscriber: SubscriberClient,
    // Holds the auto-resubscribe task handle; dropping a JoinHandle detaches but does not cancel.
    #[allow(dead_code)]
    _mgr: tokio::task::JoinHandle<()>,
}

impl RedisBus {
    /// Build the bus: connect a subscriber, SSUBSCRIBE to this instance's channel, and spawn the
    /// inbound fan-in task. The subscriber is kept alive inside the struct.
    ///
    /// Phase 5 should call: `RedisBus::new(config.instance_id.clone(), pubsub_pool).await?`
    /// where `pubsub_pool` is `redis::connect(&config.redis_pubsub_url).await?`.
    pub async fn new(instance_id: String, publisher: RedisPool) -> anyhow::Result<Self> {
        let channel = format!("mp:inst:{instance_id}");
        let conns: std::sync::Arc<RwLock<HashMap<ConnId, mpsc::UnboundedSender<String>>>> =
            Default::default();

        // Derive subscriber config from the pool so both connections target the same Redis.
        let sub_config = publisher.client_config();
        let sub = Builder::from_config(sub_config).build_subscriber_client()?;
        sub.init().await?;
        // Grab rx before ssubscribe so no messages are missed between subscribe and loop start.
        let mut rx = sub.message_rx();
        sub.ssubscribe(channel).await?;
        // Spawn auto-resubscribe on reconnect; task self-terminates when the client drops.
        let mgr = sub.manage_subscriptions();

        let conns_arc = conns.clone();
        tokio::spawn(async move {
            use tokio::sync::broadcast::error::RecvError;
            loop {
                match rx.recv().await {
                    Ok(msg) => {
                        let Some(payload) = msg.value.as_string() else {
                            continue;
                        };
                        let Ok(w) = serde_json::from_str::<Wire>(&payload) else {
                            continue;
                        };
                        if let Some(tx) = conns_arc.read().unwrap().get(&w.conn) {
                            let _ = tx.send(w.text);
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        tracing::warn!(
                            skipped = n,
                            "pubsub message_rx lagged; some cross-instance messages dropped"
                        );
                    }
                    Err(RecvError::Closed) => break,
                }
            }
        });

        Ok(Self {
            instance_id,
            publisher,
            conns,
            _subscriber: sub,
            _mgr: mgr,
        })
    }
}

#[async_trait]
impl Bus for RedisBus {
    fn instance_id(&self) -> &str {
        &self.instance_id
    }

    fn register(&self, conn: ConnId, tx: mpsc::UnboundedSender<String>) {
        self.conns.write().unwrap().insert(conn, tx);
    }

    fn unregister(&self, conn: ConnId) {
        self.conns.write().unwrap().remove(&conn);
    }

    async fn deliver(&self, target: &ConnRef, text: String) {
        if target.instance_id == self.instance_id {
            // Local: clone tx out before any await so we never hold the guard across an .await.
            let tx = self.conns.read().unwrap().get(&target.conn_id).cloned();
            if let Some(tx) = tx {
                let _ = tx.send(text);
            }
        } else {
            let wire = serde_json::to_string(&Wire {
                conn: target.conn_id,
                text,
            })
            .expect("Wire { Uuid, String } is always serializable");
            let channel = format!("mp:inst:{}", target.instance_id);
            // RedisPool doesn't impl PubsubInterface; get a client from the pool for spublish.
            let res: Result<i64, _> = self.publisher.next().spublish(channel, wire).await;
            if let Err(e) = res {
                tracing::warn!(error = %e, instance = %target.instance_id, "spublish cross-instance delivery failed");
            }
        }
    }
}

// ===== Integration tests (ignored without TEST_REDIS_URL) =====

#[cfg(test)]
mod tests {
    use super::*;

    fn test_url() -> Option<String> {
        std::env::var("TEST_REDIS_URL").ok()
    }

    // ElastiCache uses `rediss://` (TLS in transit). With `enable-rustls-ring`, `from_url` must
    // build a TLS connector for the rediss scheme and leave plain `redis://` untls'd. Building
    // the rustls config selects the crypto provider, so this test would PANIC if the provider
    // were ambiguous (the rustls 0.23 multi-provider footgun) — it guards the feature choice.
    // Pure config construction: no Redis or network needed.
    #[test]
    fn rediss_url_configures_tls_and_redis_does_not() {
        let secure =
            RedisConfig::from_url("rediss://cache.example.com:6379").expect("rediss:// parses");
        assert!(secure.uses_tls(), "rediss:// must configure TLS");
        let plain =
            RedisConfig::from_url("redis://cache.example.com:6379").expect("redis:// parses");
        assert!(!plain.uses_tls(), "redis:// must stay plaintext");
    }

    #[tokio::test]
    #[ignore = "requires TEST_REDIS_URL"]
    async fn deliver_crosses_instances() {
        let Some(url) = test_url() else { return };
        // Instance B owns the socket; instance A delivers to it via SPUBLISH.
        let bus_b = RedisBus::new("B".into(), connect(&url).await.unwrap())
            .await
            .unwrap();
        let bus_a = RedisBus::new("A".into(), connect(&url).await.unwrap())
            .await
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let conn = uuid::Uuid::new_v4();
        bus_b.register(conn, tx);
        bus_a
            .deliver(
                &ConnRef {
                    instance_id: "B".into(),
                    conn_id: conn,
                },
                "hello".into(),
            )
            .await;
        let got = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("delivery timed out")
            .expect("channel closed");
        assert_eq!(
            got, "hello",
            "cross-instance message must arrive on B's socket"
        );
    }

    #[tokio::test]
    #[ignore = "requires TEST_REDIS_URL"]
    async fn actions_count_accumulates_per_game() {
        let Some(url) = test_url() else { return };
        let s = RedisControlStore::new(connect(&url).await.unwrap());
        s.add_actions("blackjack", 100).await;
        s.add_actions("blackjack", 50).await;
        let snap = s.snapshot().await;
        assert!(snap.total_actions >= 150);
        assert!(
            snap.per_game
                .get("blackjack")
                .is_some_and(|g| g.total_actions >= 150),
            "per-game actions must accumulate"
        );
    }

    #[tokio::test]
    #[ignore = "requires TEST_REDIS_URL"]
    async fn session_roundtrip() {
        let Some(url) = test_url() else { return };
        let s = RedisControlStore::new(connect(&url).await.unwrap());
        let id = uuid::Uuid::new_v4().to_string();
        let tunnel = crate::routes::TunnelRef {
            tunnel_id: "t1".to_owned(),
            party_a: "0xA".to_owned(),
            party_b: "0xB".to_owned(),
        };
        let rec = SessionRecord {
            game: "chess".to_owned(),
            tunnels: vec![tunnel.clone()],
            stats_token: "tok".to_owned(),
        };
        s.put_session(&id, rec.clone()).await;
        let got = s.get_session(&id).await.expect("session must round-trip");
        assert_eq!(got.game, rec.game);
        assert_eq!(got.tunnels.len(), 1);
        assert_eq!(got.tunnels[0].tunnel_id, tunnel.tunnel_id);
    }

    #[tokio::test]
    #[ignore = "requires TEST_REDIS_URL"]
    async fn join_or_pair_pairs_each_waiter_exactly_once_under_concurrency() {
        let Some(url) = test_url() else { return };
        let s = std::sync::Arc::new(RedisMpStore::new(connect(&url).await.unwrap()));
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        let mut handles = vec![];
        for i in 0..50u32 {
            let s = s.clone();
            let game = game.clone();
            handles.push(tokio::spawn(async move {
                let cr = ConnRef {
                    instance_id: "i".into(),
                    conn_id: uuid::Uuid::new_v4(),
                };
                s.join_or_pair(
                    &game,
                    crate::mp::Waiting {
                        wallet: format!("0x{i}"),
                        conn: cr,
                    },
                )
                .await
            }));
        }
        let mut pairs = 0u32;
        let mut parked = 0u32;
        for h in handles {
            if h.await.unwrap().is_some() {
                pairs += 1;
            } else {
                parked += 1;
            }
        }
        // 50 concurrent joiners → exactly 25 pair events, 25 parked. The Lua script guarantees
        // atomicity, so there can never be a double-pair.
        assert_eq!(pairs, 25, "expected 25 pair events");
        assert_eq!(parked, 25, "expected 25 parked waiters");
    }

    #[tokio::test]
    #[ignore = "requires TEST_REDIS_URL"]
    async fn recent_events_ring_dedupes_and_caps() {
        use crate::state::{TunnelEvent, TunnelEventKind};
        let Some(url) = test_url() else { return };
        let s = RedisControlStore::new(connect(&url).await.unwrap());
        let ev = |digest: &str| TunnelEvent {
            tunnel_id: "0xt".into(),
            kind: TunnelEventKind::Settled,
            party_a_balance: Some(1),
            party_b_balance: Some(1),
            transcript_root: None,
            tx_digest: digest.into(),
            timestamp_ms: 1,
            proof_url: None,
        };
        let tag = uuid::Uuid::new_v4().simple().to_string();
        s.push_recent_event(ev(&format!("{tag}-a"))).await;
        s.push_recent_event(ev(&format!("{tag}-a"))).await; // replay — no-op
        s.push_recent_event(ev(&format!("{tag}-b"))).await;
        let got = s.recent_events().await;
        // newest-first; our two unique digests are at the front (other tests may share the ring).
        assert_eq!(got[0].tx_digest, format!("{tag}-b"));
        assert_eq!(got[1].tx_digest, format!("{tag}-a"));
        assert!(got.len() <= crate::store::RECENT_EVENTS_CAP);
    }

    #[tokio::test]
    #[ignore = "requires TEST_REDIS_URL"]
    async fn join_or_pair_never_pairs_wallet_with_itself() {
        let Some(url) = test_url() else { return };
        let s = RedisMpStore::new(connect(&url).await.unwrap());
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        let wallet = "0xself".to_owned();

        // First call: parks self.
        let cr1 = ConnRef {
            instance_id: "i".into(),
            conn_id: uuid::Uuid::new_v4(),
        };
        let first = s
            .join_or_pair(
                &game,
                crate::mp::Waiting {
                    wallet: wallet.clone(),
                    conn: cr1,
                },
            )
            .await;
        assert!(first.is_none(), "first call must park, not pair");

        // Second call (reconnect): stale self-entry must be dropped; wallet parks again.
        let cr2 = ConnRef {
            instance_id: "i".into(),
            conn_id: uuid::Uuid::new_v4(),
        };
        let second = s
            .join_or_pair(
                &game,
                crate::mp::Waiting {
                    wallet: wallet.clone(),
                    conn: cr2,
                },
            )
            .await;
        assert!(
            second.is_none(),
            "reconnecting wallet must not pair with itself"
        );
    }
}
