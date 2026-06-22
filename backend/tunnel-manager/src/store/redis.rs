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
const MATCH_TTL: i64 = 6 * 3600;
// Dedup horizon for recent-events: must exceed the indexer's worst-case cursor-replay window.
const SEEN_TTL: i64 = 24 * 3600;

// Atomic dedup-then-push for the recent-events ring. Dedup is a per-digest
// `events:seen:<digest>` key with a TTL, so the dedup set self-expires (no unbounded growth).
// A re-polled event (cursor restart / second indexer) never double-inserts. Newest-first
// via LPUSH; LTRIM bounds the list.
//
// On a seen digest it is NOT a blind no-op: the /settle handler's enriched row (with a Walrus
// proofUrl) and the indexer's bare row race for the same close — and the handler loses when its
// ~6s Walrus upload lands its push after the indexer's 1s poll. So when this row carries a
// proofUrl the stored one lacks, upgrade it in place (cjson + LSET) so the proof link is never
// lost; never downgrade an existing proofUrl. Atomic under the script lock, so the LRANGE/LSET
// pair sees no concurrent mutation.
// KEYS[1]=events:recent KEYS[2]=events:seen:<digest>  ARGV[1]=json ARGV[2]=digest ARGV[3]=cap ARGV[4]=ttl
const PUSH_RECENT_EVENT: &str = r#"
if redis.call('SET', KEYS[2], '1', 'NX', 'EX', tonumber(ARGV[4])) then
  redis.call('LPUSH', KEYS[1], ARGV[1])
  redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[3]) - 1)
  return 1
end
local incoming = cjson.decode(ARGV[1])
if incoming.proofUrl == nil or incoming.proofUrl == cjson.null then
  return 0
end
local rows = redis.call('LRANGE', KEYS[1], 0, -1)
for i = 1, #rows do
  local row = cjson.decode(rows[i])
  if row.txDigest == ARGV[2] then
    if row.proofUrl == nil or row.proofUrl == cjson.null then
      redis.call('LSET', KEYS[1], i - 1, ARGV[1])
      return 1
    end
    return 0
  end
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
        // Per-game only: the total is derived in `snapshot` as the sum of per-game keys.
        // Writing a separate total would be a redundant, single-slot write-hotspot (every
        // instance, every second) and could diverge from the per-game sum on partial failure.
        let res: Result<i64, _> = self
            .pool
            .incr_by(format!("stats:actions:game:{game}"), delta as i64)
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis add_actions incr per-game failed");
        }
    }

    async fn snapshot(&self) -> StatsSnapshot {
        let active: i64 = self.pool.scard("stats:tunnels:active").await.unwrap_or(0);
        let settled: i64 = self.pool.scard("stats:tunnels:settled").await.unwrap_or(0);

        let mut total_actions: u64 = 0;
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
                    total_actions += v as u64;
                } else {
                    entry.tunnels = v as u64;
                }
            }
        }

        let recent_events = self.recent_events().await;
        StatsSnapshot {
            tps: 0.0, // filled by the broadcaster from its per-tick diff
            total_actions,
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
                vec![
                    "events:recent".to_string(),
                    format!("events:seen:{}", ev.tx_digest),
                ],
                vec![
                    json,
                    ev.tx_digest.clone(),
                    crate::store::RECENT_EVENTS_CAP.to_string(),
                    SEEN_TTL.to_string(),
                ],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis push_recent_event eval failed");
        }
    }

    async fn recent_events(&self) -> Vec<TunnelEvent> {
        let raws: Vec<String> = self
            .pool
            .lrange(
                "events:recent",
                0,
                (crate::store::RECENT_EVENTS_CAP - 1) as i64,
            )
            .await
            .unwrap_or_default();
        raws.iter()
            .filter_map(|j| serde_json::from_str(j).ok())
            .collect()
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

// Presence compare-and-delete on a single key holding the full ConnRef JSON: delete only if
// the stored conn_id still matches. cjson.decode reads conn_id (a string) only; nothing is
// re-encoded. KEYS[1]=presence:<wallet>  ARGV[1]=conn_id string
const CLEAR_PRESENCE_IF: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ref = cjson.decode(raw)
if ref.conn_id == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
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

// Atomic accept: return the invite JSON and delete it iff it exists and is addressed to the
// accepter; else nil. Single-winner under concurrent accepts (no GET→DEL gap).
// KEYS[1]=invite:<match_id>  ARGV[1]=accepter wallet
const TAKE_INVITE: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local inv = cjson.decode(raw)
if inv.to ~= ARGV[1] then return false end
redis.call('DEL', KEYS[1])
return raw
"#;

// Write the match HASH atomically with its 6h TTL. Core fields are always present; tunnel_id
// and checkpoint are written only when non-empty (sentinel '' means "skip"). The checkpoint is
// stored verbatim (opaque JSON) and its nonce kept as a plain integer field, so no balance is
// ever cjson-round-tripped. KEYS[1]=match:<id>
// ARGV: 1=game 2=seat_a 3=seat_b 4=conn_a 5=conn_b 6=tunnel_id|'' 7=checkpoint|'' 8=nonce|'' 9=ttl
const PUT_MATCH: &str = r#"
redis.call('HSET', KEYS[1], 'game', ARGV[1], 'seat_a', ARGV[2], 'seat_b', ARGV[3], 'conn_a', ARGV[4], 'conn_b', ARGV[5])
if ARGV[6] ~= '' then redis.call('HSET', KEYS[1], 'tunnel_id', ARGV[6]) end
if ARGV[7] ~= '' then redis.call('HSET', KEYS[1], 'latest_checkpoint', ARGV[7], 'checkpoint_nonce', ARGV[8]) end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[9]))
return 1
"#;

// Monotonic checkpoint CAS: store the new checkpoint (verbatim) only if its nonce >= the stored
// one. Compares integers; never decodes the checkpoint body, so balances stay byte-exact.
// KEYS[1]=match:<id>  ARGV[1]=nonce  ARGV[2]=checkpoint json  ARGV[3]=ttl
const RECORD_CHECKPOINT: &str = r#"
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local cur = redis.call('HGET', KEYS[1], 'checkpoint_nonce')
if cur and tonumber(ARGV[1]) < tonumber(cur) then return 0 end
redis.call('HSET', KEYS[1], 'latest_checkpoint', ARGV[2], 'checkpoint_nonce', ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
"#;

// Set tunnel_id only if the match still exists; refresh the 6h TTL. Mirrors the memory
// impl's no-op-on-absent behavior and avoids leaking a one-field hash.
// KEYS[1]=match:<id>  ARGV[1]=tunnel_id  ARGV[2]=ttl
const SET_TUNNEL_ID: &str = r#"
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'tunnel_id', ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
"#;

// Rebind a seat's ConnRef, authorized by seat ownership, and refresh the TTL. Returns 'a'/'b'
// for the rebound seat, or false if the match is gone / the wallet owns no seat. O(1): two
// HGETs + one HSET + EXPIRE, no loops, no cjson (ConnRef carries no numeric balance).
// KEYS[1]=match:<id>  ARGV[1]=wallet  ARGV[2]=ConnRef json  ARGV[3]=ttl
const REBIND_MATCH_CONN: &str = r#"
local sa = redis.call('HGET', KEYS[1], 'seat_a')
if not sa then return false end
if sa == ARGV[1] then
  redis.call('HSET', KEYS[1], 'conn_a', ARGV[2])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 'a'
end
local sb = redis.call('HGET', KEYS[1], 'seat_b')
if sb == ARGV[1] then
  redis.call('HSET', KEYS[1], 'conn_b', ARGV[2])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 'b'
end
return false
"#;

#[async_trait]
impl MpStore for RedisMpStore {
    async fn set_presence(&self, wallet: &str, at: ConnRef) {
        // One key holds the full ConnRef JSON: get_presence reads it; clear_presence_if's Lua
        // decodes conn_id from it. No separate mirror to orphan.
        let res: Result<(), _> = self
            .pool
            .set(
                format!("presence:{wallet}"),
                serde_json::to_string(&at).unwrap(),
                None,
                None,
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis set_presence failed");
        }
    }

    async fn get_presence(&self, wallet: &str) -> Option<ConnRef> {
        let v: Option<String> = self
            .pool
            .get(format!("presence:{wallet}"))
            .await
            .ok()
            .flatten();
        v.and_then(|j| serde_json::from_str(&j).ok())
    }

    async fn clear_presence_if(&self, wallet: &str, conn: crate::mp::ConnId) {
        let res: Result<i64, _> = self
            .pool
            .eval(
                CLEAR_PRESENCE_IF,
                vec![format!("presence:{wallet}")],
                vec![conn.to_string()],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis clear_presence_if eval failed");
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
        let raw: Option<String> = match self
            .pool
            .eval::<Option<String>, _, _, _>(
                TAKE_INVITE,
                vec![format!("invite:{match_id}")],
                vec![accepter.to_owned()],
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "redis take_invite eval failed");
                None
            }
        };
        raw.and_then(|j| serde_json::from_str(&j).ok())
    }

    async fn drop_invite(&self, match_id: &str) {
        let res: Result<i64, _> = self.pool.del(format!("invite:{match_id}")).await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis drop_invite del failed");
        }
    }

    async fn put_match(&self, match_id: &str, m: crate::mp::MatchRecord) {
        let (cp_json, cp_nonce) = match &m.latest_checkpoint {
            Some(cp) => (serde_json::to_string(cp).unwrap(), cp.nonce.to_string()),
            None => (String::new(), String::new()),
        };
        let res: Result<i64, _> = self
            .pool
            .eval(
                PUT_MATCH,
                vec![format!("match:{match_id}")],
                vec![
                    m.game,
                    m.seat_a,
                    m.seat_b,
                    serde_json::to_string(&m.conn_a).unwrap(),
                    serde_json::to_string(&m.conn_b).unwrap(),
                    m.tunnel_id.unwrap_or_default(),
                    cp_json,
                    cp_nonce,
                    MATCH_TTL.to_string(),
                ],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis put_match eval failed");
        }
    }

    async fn get_match(&self, match_id: &str) -> Option<crate::mp::MatchRecord> {
        let h: HashMap<String, String> =
            self.pool.hgetall(format!("match:{match_id}")).await.ok()?;
        if h.is_empty() {
            return None;
        }
        Some(crate::mp::MatchRecord {
            game: h.get("game")?.clone(),
            seat_a: h.get("seat_a")?.clone(),
            seat_b: h.get("seat_b")?.clone(),
            conn_a: serde_json::from_str(h.get("conn_a")?).ok()?,
            conn_b: serde_json::from_str(h.get("conn_b")?).ok()?,
            tunnel_id: h.get("tunnel_id").cloned(),
            latest_checkpoint: h
                .get("latest_checkpoint")
                .and_then(|s| serde_json::from_str(s).ok()),
        })
    }

    async fn set_tunnel_id(&self, match_id: &str, tunnel_id: &str) {
        let res: Result<i64, _> = self
            .pool
            .eval(
                SET_TUNNEL_ID,
                vec![format!("match:{match_id}")],
                vec![tunnel_id.to_owned(), MATCH_TTL.to_string()],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis set_tunnel_id eval failed");
        }
    }

    async fn record_checkpoint(&self, match_id: &str, cp: crate::mp::Checkpoint) {
        let res: Result<i64, _> = self
            .pool
            .eval(
                RECORD_CHECKPOINT,
                vec![format!("match:{match_id}")],
                vec![
                    cp.nonce.to_string(),
                    serde_json::to_string(&cp).unwrap(),
                    MATCH_TTL.to_string(),
                ],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis record_checkpoint eval failed");
        }
    }

    async fn rebind_match_conn(
        &self,
        match_id: &str,
        wallet: &str,
        at: ConnRef,
    ) -> Option<crate::mp::Seat> {
        let res: Result<Option<String>, _> = self
            .pool
            .eval(
                REBIND_MATCH_CONN,
                vec![format!("match:{match_id}")],
                vec![
                    wallet.to_owned(),
                    serde_json::to_string(&at).unwrap(),
                    MATCH_TTL.to_string(),
                ],
            )
            .await;
        match res {
            Ok(Some(s)) if s == "a" => Some(crate::mp::Seat::A),
            Ok(Some(s)) if s == "b" => Some(crate::mp::Seat::B),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!(error = %e, "redis rebind_match_conn eval failed");
                None
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

    async fn publish_raw(&self, channel: &str, payload: String) {
        // Regular PUBLISH (not SPUBLISH) so the indexer subscribes with regular SUBSCRIBE.
        let _: Result<i64, _> = self.publisher.next().publish(channel, payload).await;
    }
}

// ===== Integration tests =====

#[cfg(test)]
mod tests {
    use testcontainers_modules::redis::Redis;
    use testcontainers_modules::testcontainers::{runners::AsyncRunner, ContainerAsync, ImageExt};

    use super::*;

    /// Start an ephemeral Redis and return a connected pool. The returned container must be held
    /// for the test's lifetime (drop = stop). Per-test isolation: no shared keys, runs in parallel.
    ///
    /// Pinned to a stable Redis 7 minor: `RedisBus` uses sharded pub/sub (`SSUBSCRIBE`/`SPUBLISH`),
    /// which only exists on Redis >= 7.0, so the `redis` module's default tag (5.0) makes
    /// `RedisBus::new` fail. Pinning the minor (not the floating `7-alpine`) keeps CI reproducible.
    async fn redis_fixture() -> (ContainerAsync<Redis>, RedisPool) {
        let node = Redis::default()
            .with_tag("7.4-alpine")
            .start()
            .await
            .expect("start redis container");
        let port = node.get_host_port_ipv4(6379).await.expect("redis port");
        let pool = connect(&format!("redis://127.0.0.1:{port}")).await.unwrap();
        (node, pool)
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
    async fn deliver_crosses_instances() {
        // Both buses must share one Redis so SPUBLISH on A reaches B's subscriber.
        let (redis, pool_b) = redis_fixture().await;
        let port = redis.get_host_port_ipv4(6379).await.expect("redis port");
        let pool_a = connect(&format!("redis://127.0.0.1:{port}")).await.unwrap();
        // Instance B owns the socket; instance A delivers to it via SPUBLISH.
        let bus_b = RedisBus::new("B".into(), pool_b).await.unwrap();
        let bus_a = RedisBus::new("A".into(), pool_a).await.unwrap();
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
    async fn actions_count_accumulates_per_game() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisControlStore::new(pool);
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
    async fn session_roundtrip() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisControlStore::new(pool);
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
    async fn join_or_pair_pairs_each_waiter_exactly_once_under_concurrency() {
        let (_redis, pool) = redis_fixture().await;
        let s = std::sync::Arc::new(RedisMpStore::new(pool));
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
    async fn recent_events_ring_dedupes_and_caps() {
        use crate::state::{TunnelEvent, TunnelEventKind};
        let (_redis, pool) = redis_fixture().await;
        let s = RedisControlStore::new(pool);
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
        // newest-first; our two unique digests are at the front of this test's fresh-container ring.
        assert_eq!(got[0].tx_digest, format!("{tag}-b"));
        assert_eq!(got[1].tx_digest, format!("{tag}-a"));
        assert!(got.len() <= crate::store::RECENT_EVENTS_CAP);
    }

    // The Walrus proofUrl must survive the indexer/handler race for the same digest, in either
    // arrival order — same contract as the in-memory store, exercised through the Lua upgrade
    // path. Without it a settled row in the cross-instance ring shows no proof link.
    #[tokio::test]
    async fn recent_events_proof_url_survives_race_either_order() {
        use crate::state::{TunnelEvent, TunnelEventKind};
        let (_redis, pool) = redis_fixture().await;
        let s = RedisControlStore::new(pool);
        let proof = "https://agg/v1/blobs/xyz";
        let ev = |digest: &str, p: Option<&str>| TunnelEvent {
            tunnel_id: "0xt".into(),
            kind: TunnelEventKind::Settled,
            party_a_balance: Some(1),
            party_b_balance: Some(1),
            transcript_root: None,
            tx_digest: digest.into(),
            timestamp_ms: 1,
            proof_url: p.map(Into::into),
        };
        let find = |rows: &[TunnelEvent], d: &str| rows.iter().find(|r| r.tx_digest == d).cloned();

        // indexer (bare) first, then handler (enriched): bare row is upgraded.
        let a = format!("{}-a", uuid::Uuid::new_v4().simple());
        s.push_recent_event(ev(&a, None)).await;
        s.push_recent_event(ev(&a, Some(proof))).await;
        let ra = find(&s.recent_events().await, &a).expect("row present");
        assert_eq!(
            ra.proof_url.as_deref(),
            Some(proof),
            "bare row upgraded to the proofUrl"
        );

        // handler (enriched) first, then indexer (bare): proofUrl not downgraded.
        let b = format!("{}-b", uuid::Uuid::new_v4().simple());
        s.push_recent_event(ev(&b, Some(proof))).await;
        s.push_recent_event(ev(&b, None)).await;
        let rb = find(&s.recent_events().await, &b).expect("row present");
        assert_eq!(
            rb.proof_url.as_deref(),
            Some(proof),
            "bare row never downgrades a proofUrl"
        );
    }

    #[tokio::test]
    async fn recent_events_dedup_key_is_per_digest_with_ttl() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisControlStore::new(pool.clone());
        let digest = format!("d{}", uuid::Uuid::new_v4().simple());
        let ev = crate::state::TunnelEvent {
            tunnel_id: "0xt".into(),
            kind: crate::state::TunnelEventKind::Settled,
            party_a_balance: Some(1),
            party_b_balance: Some(1),
            transcript_root: None,
            tx_digest: digest.clone(),
            timestamp_ms: 1,
            proof_url: None,
        };
        s.push_recent_event(ev).await;
        // Dedup is tracked by a per-digest key that carries a positive TTL (self-cleaning).
        let ttl: i64 = pool
            .ttl(format!("events:seen:{digest}"))
            .await
            .unwrap_or(-2);
        assert!(ttl > 0, "per-digest dedup key must have a TTL, got {ttl}");
    }

    #[tokio::test]
    async fn take_invite_yields_some_to_exactly_one_concurrent_accepter() {
        let (_redis, pool) = redis_fixture().await;
        let s = std::sync::Arc::new(RedisMpStore::new(pool));
        let mid = format!("m{}", uuid::Uuid::new_v4().simple());
        let inv = crate::mp::DirectedInvite {
            from: "0xa".into(),
            to: "0xb".into(),
            game: "ttt".into(),
            from_conn: ConnRef {
                instance_id: "i".into(),
                conn_id: uuid::Uuid::nil(),
            },
        };
        s.put_invite(&mid, inv).await;
        // Two concurrent accepts by the invited wallet; exactly one must win.
        let (s1, s2, m1, m2) = (s.clone(), s.clone(), mid.clone(), mid.clone());
        let h1 = tokio::spawn(async move { s1.take_invite(&m1, "0xb").await });
        let h2 = tokio::spawn(async move { s2.take_invite(&m2, "0xb").await });
        let wins = [h1.await.unwrap(), h2.await.unwrap()]
            .iter()
            .filter(|o| o.is_some())
            .count();
        assert_eq!(
            wins, 1,
            "exactly one concurrent accept may consume the invite"
        );
    }

    #[tokio::test]
    async fn take_invite_rejects_wrong_recipient_and_preserves_invite() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let mid = format!("m{}", uuid::Uuid::new_v4().simple());
        let inv = crate::mp::DirectedInvite {
            from: "0xa".into(),
            to: "0xb".into(),
            game: "ttt".into(),
            from_conn: ConnRef {
                instance_id: "i".into(),
                conn_id: uuid::Uuid::nil(),
            },
        };
        s.put_invite(&mid, inv).await;
        // Wrong recipient must get None and leave the invite intact.
        let rejected = s.take_invite(&mid, "0xwrong").await;
        assert!(rejected.is_none(), "wrong recipient must be rejected");
        // The invite must still be present for the correct recipient.
        let accepted = s.take_invite(&mid, "0xb").await;
        assert!(
            accepted.is_some(),
            "invite must still be present after wrong-recipient attempt"
        );
    }

    #[tokio::test]
    async fn join_or_pair_never_pairs_wallet_with_itself() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
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

    #[tokio::test]
    async fn actions_total_is_derived_not_a_separate_key() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisControlStore::new(pool.clone());
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        s.add_actions(&game, 7).await;
        s.add_actions(&game, 5).await;
        // Total must come from summing per-game keys, never from a written aggregate.
        let legacy: Option<i64> = pool.get("stats:actions:total").await.ok().flatten();
        assert!(legacy.is_none(), "stats:actions:total must not be written");
        let snap = s.snapshot().await;
        assert_eq!(snap.per_game[&game].total_actions, 12);
        assert!(snap.total_actions >= 12, "total is the sum of per-game");
    }

    #[tokio::test]
    async fn presence_uses_one_key_and_cas_clears_it() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool.clone());
        let wallet = format!("0x{}", uuid::Uuid::new_v4().simple());
        let conn = uuid::Uuid::new_v4();
        s.set_presence(
            &wallet,
            ConnRef {
                instance_id: "A".into(),
                conn_id: conn,
            },
        )
        .await;
        // No mirror key may exist.
        let mirror: Option<String> = pool
            .get(format!("presence:ref:{wallet}"))
            .await
            .ok()
            .flatten();
        assert!(mirror.is_none(), "no presence:ref mirror key");
        // Round-trips the full ConnRef.
        let got = s.get_presence(&wallet).await.expect("presence present");
        assert_eq!((got.instance_id.as_str(), got.conn_id), ("A", conn));
        // CAS with a wrong conn must not clear.
        s.clear_presence_if(&wallet, uuid::Uuid::new_v4()).await;
        assert!(
            s.get_presence(&wallet).await.is_some(),
            "wrong conn must not clear"
        );
        // CAS with the right conn clears it, leaving no key behind.
        s.clear_presence_if(&wallet, conn).await;
        assert!(
            s.get_presence(&wallet).await.is_none(),
            "matching conn clears"
        );
        let leftover: Option<String> = pool.get(format!("presence:{wallet}")).await.ok().flatten();
        assert!(leftover.is_none(), "no orphaned presence key");
    }

    fn sample_match() -> crate::mp::MatchRecord {
        let cr = ConnRef {
            instance_id: "i".into(),
            conn_id: uuid::Uuid::new_v4(),
        };
        crate::mp::MatchRecord {
            game: "ttt".into(),
            seat_a: "0xa".into(),
            seat_b: "0xb".into(),
            conn_a: cr.clone(),
            conn_b: cr,
            tunnel_id: None,
            latest_checkpoint: None,
        }
    }

    #[tokio::test]
    async fn match_record_round_trips_through_hash() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let mid = format!("m{}", uuid::Uuid::new_v4().simple());
        let m = sample_match();
        s.put_match(&mid, m.clone()).await;
        let got = s.get_match(&mid).await.expect("match round-trips");
        assert_eq!(got.game, m.game);
        assert_eq!((got.seat_a, got.seat_b), (m.seat_a, m.seat_b));
        assert_eq!(got.conn_a.conn_id, m.conn_a.conn_id);
        assert!(got.tunnel_id.is_none() && got.latest_checkpoint.is_none());
    }

    #[tokio::test]
    async fn tunnel_id_and_checkpoint_writes_do_not_clobber() {
        let (_redis, pool) = redis_fixture().await;
        let s = std::sync::Arc::new(RedisMpStore::new(pool));
        let mid = format!("m{}", uuid::Uuid::new_v4().simple());
        s.put_match(&mid, sample_match()).await;
        // A huge balance (> 2^53) must survive byte-exact: it rides in the checkpoint and is
        // submitted on-chain, so any precision loss is a correctness break.
        let big = 9_007_199_254_740_993u64; // 2^53 + 1
        let cp = crate::mp::Checkpoint {
            nonce: 4,
            party_a_balance: big,
            party_b_balance: 1,
            state_hash: "h".into(),
            sig_a: "a".into(),
            sig_b: "b".into(),
        };
        let (s1, s2, m1, m2) = (s.clone(), s.clone(), mid.clone(), mid.clone());
        let h1 = tokio::spawn(async move { s1.set_tunnel_id(&m1, "0xtunnel").await });
        let h2 = tokio::spawn(async move { s2.record_checkpoint(&m2, cp).await });
        h1.await.unwrap();
        h2.await.unwrap();
        let got = s.get_match(&mid).await.unwrap();
        assert_eq!(
            got.tunnel_id.as_deref(),
            Some("0xtunnel"),
            "tunnel_id survived"
        );
        let stored = got.latest_checkpoint.expect("checkpoint survived");
        assert_eq!(stored.nonce, 4);
        assert_eq!(
            stored.party_a_balance, big,
            "u64 balance must be byte-exact"
        );
    }

    #[tokio::test]
    async fn rebind_match_conn_rebinds_seat_and_rejects_non_owner() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let mid = format!("m{}", uuid::Uuid::new_v4().simple());
        s.put_match(&mid, sample_match()).await; // seat_a="0xa", seat_b="0xb"
        let new = ConnRef {
            instance_id: "i2".into(),
            conn_id: uuid::Uuid::new_v4(),
        };
        // Non-owner → None, no change.
        assert_eq!(
            s.rebind_match_conn(&mid, "0xstranger", new.clone()).await,
            None
        );
        // Seat A owner rebinds conn_a; conn_b untouched.
        let before = s.get_match(&mid).await.unwrap();
        assert_eq!(
            s.rebind_match_conn(&mid, "0xa", new.clone()).await,
            Some(crate::mp::Seat::A)
        );
        let after = s.get_match(&mid).await.unwrap();
        assert_eq!(after.conn_a.conn_id, new.conn_id, "conn_a rebound");
        assert_eq!(
            after.conn_b.conn_id, before.conn_b.conn_id,
            "conn_b untouched"
        );
        // Absent match → None (EXISTS-guarded by seat_a presence).
        let gone = format!("m{}", uuid::Uuid::new_v4().simple());
        assert_eq!(s.rebind_match_conn(&gone, "0xa", new).await, None);
    }

    #[tokio::test]
    async fn record_checkpoint_keeps_highest_nonce_redis() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let mid = format!("m{}", uuid::Uuid::new_v4().simple());
        s.put_match(&mid, sample_match()).await;
        let cp = |n| crate::mp::Checkpoint {
            nonce: n,
            party_a_balance: 1,
            party_b_balance: 1,
            state_hash: "h".into(),
            sig_a: "a".into(),
            sig_b: "b".into(),
        };
        s.record_checkpoint(&mid, cp(5)).await;
        s.record_checkpoint(&mid, cp(3)).await; // stale, must be ignored
        assert_eq!(
            s.get_match(&mid)
                .await
                .unwrap()
                .latest_checkpoint
                .unwrap()
                .nonce,
            5
        );
    }
}
