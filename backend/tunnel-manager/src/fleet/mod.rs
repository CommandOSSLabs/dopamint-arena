//! Warm server-side bot pool for arena allocation (ADR-0023).
//!
//! Per-instance and in-memory: a fleet bot holds a `/v1/fleet` WebSocket to ONE backend
//! instance, so allocation is local to that instance. Cross-instance (HA) allocation is
//! deferred, mirroring ADR-0011's deferred queue sharding — the demo runs the fleet against a
//! single instance.
//!
//! Reservation is O(1) pop-from-free, never FIFO: a bot is always available, so the arena has no
//! matchmaking hold (unlike the human `/v1/mp` path). Lifecycle: a bot `register`s (free) → is
//! `reserve`d for a user (notified `Reserved`) → the user opens the tunnel and the backend pushes
//! `Opened` → the bot deposits its seat and plays. **One match per registration**: the bot
//! disconnects when the match ends, which `unregister`s it; an unclaimed reservation (user never
//! opened) is reclaimed after `RESERVATION_TTL_MS`.

pub mod bus_transport;
pub mod ws;

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// How long a reservation may sit un-opened before the bot is reclaimed to the free set (the user
/// allocated bots but never signed the open). An already-`Opened` reservation is a live match and
/// is never reclaimed by the TTL.
pub const RESERVATION_TTL_MS: u64 = 30_000;

/// Backend → bot control messages over `/v1/fleet`. camelCase to match every other wire type
/// (ADR-0002). `Reserved` = "you're matched to this user"; `Opened` = "the user created the
/// tunnel — deposit your seat".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FleetServerMsg {
    Reserved {
        match_id: String,
        opponent_wallet: String,
    },
    Opened {
        match_id: String,
        tunnel_id: String,
    },
}

/// Bot → backend control messages over `/v1/fleet`. `register` announces the bot to the pool;
/// unknown variants decode to `Other` so the bot and backend can evolve independently.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FleetClientMsg {
    Register {
        game: String,
        /// The bot's ephemeral pubkey (hex) — tunnel party B's `pk`, verifies its move signatures.
        eph_pubkey: String,
        /// The bot's on-chain address — tunnel party B's `address`. Distinct from `eph_pubkey`:
        /// it funds/receives seat B and gates `deposit_party_b`. The frontend needs both to build
        /// the open PTB's party B.
        address: String,
    },
    #[serde(other)]
    Other,
}

/// A registered bot. Party B in a tunnel is identified by TWO keys: `address` (on-chain identity —
/// funds/receives seat B) and `eph_pubkey` (signs co-signed move updates). `ctrl` pushes control
/// messages to the bot's `/v1/fleet` socket task.
#[derive(Clone)]
pub struct BotHandle {
    pub eph_pubkey: String,
    pub address: String,
    pub ctrl: mpsc::UnboundedSender<FleetServerMsg>,
}

/// What `reserve` hands back to the allocate handler: the minted match id, the game, and the bot's
/// party-B identity (both keys) the frontend needs to build the open PTB.
pub struct Reservation {
    pub match_id: String,
    pub game: String,
    pub eph_pubkey: String,
    pub address: String,
}

struct Reserved {
    bot_id: u64,
    game: String,
    bot: BotHandle,
    reserved_at_ms: u64,
    /// Set once the user's `Opened` is delivered — a live match, exempt from TTL reclaim.
    opened: bool,
}

/// Per-instance warm bot pool. Internally synchronized so it lives as a shared `AppState` field
/// (like `chat`/`pairing`) and is used through `Arc<AppState>` with `&self`. Operations are short
/// and do no IO under the lock (the `ctrl` send is a non-blocking `unbounded_send`).
#[derive(Default)]
pub struct BotPool {
    inner: Mutex<PoolInner>,
}

#[derive(Default)]
struct PoolInner {
    free: HashMap<String, Vec<(u64, BotHandle)>>, // game -> [(bot_id, handle)]
    reserved: HashMap<String, Reserved>,          // match_id -> reservation
    next_bot_id: u64,
    next_match: u64,
}

impl BotPool {
    /// Add a bot to the free set for `game`. Returns a `bot_id` the WS handler passes to
    /// `unregister` when the socket closes.
    pub fn register(&self, game: &str, bot: BotHandle) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        inner.next_bot_id += 1;
        let id = inner.next_bot_id;
        inner
            .free
            .entry(game.to_owned())
            .or_default()
            .push((id, bot));
        id
    }

    /// Remove a bot wherever it lives (free set or a held reservation) — called when its socket
    /// closes. A reservation it held is dropped (that user simply won't get this game).
    pub fn unregister(&self, bot_id: u64) {
        let mut inner = self.inner.lock().unwrap();
        for bots in inner.free.values_mut() {
            bots.retain(|(id, _)| *id != bot_id);
        }
        let drop_matches: Vec<String> = inner
            .reserved
            .iter()
            .filter(|(_, r)| r.bot_id == bot_id)
            .map(|(m, _)| m.clone())
            .collect();
        for m in drop_matches {
            inner.reserved.remove(&m);
        }
    }

    /// Reserve one free bot for `game`, minting a match id. `None` if no bot is free.
    pub fn reserve(&self, game: &str, now_ms: u64) -> Option<Reservation> {
        let mut inner = self.inner.lock().unwrap();
        let (bot_id, bot) = inner.free.get_mut(game)?.pop()?;
        inner.next_match += 1;
        let match_id = format!("arena_{}", inner.next_match);
        let eph_pubkey = bot.eph_pubkey.clone();
        let address = bot.address.clone();
        inner.reserved.insert(
            match_id.clone(),
            Reserved {
                bot_id,
                game: game.to_owned(),
                bot,
                reserved_at_ms: now_ms,
                opened: false,
            },
        );
        Some(Reservation {
            match_id,
            game: game.to_owned(),
            eph_pubkey,
            address,
        })
    }

    /// Push a control message to the bot holding `match_id`. Delivering `Opened` also marks the
    /// reservation live (TTL-exempt). Returns whether a bot was found and the send queued.
    pub fn notify(&self, match_id: &str, msg: FleetServerMsg) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(r) = inner.reserved.get_mut(match_id) else {
            return false;
        };
        if matches!(msg, FleetServerMsg::Opened { .. }) {
            r.opened = true;
        }
        r.bot.ctrl.send(msg).is_ok()
    }

    /// Reclaim bots from reservations that were never opened within the TTL (the user allocated
    /// but never signed the open). Live (`Opened`) matches are left alone.
    pub fn reclaim_expired(&self, now_ms: u64) {
        let mut inner = self.inner.lock().unwrap();
        let expired: Vec<String> = inner
            .reserved
            .iter()
            .filter(|(_, r)| {
                !r.opened && now_ms.saturating_sub(r.reserved_at_ms) > RESERVATION_TTL_MS
            })
            .map(|(m, _)| m.clone())
            .collect();
        for m in expired {
            if let Some(r) = inner.reserved.remove(&m) {
                inner
                    .free
                    .entry(r.game)
                    .or_default()
                    .push((r.bot_id, r.bot));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(pk: &str) -> (BotHandle, mpsc::UnboundedReceiver<FleetServerMsg>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            BotHandle {
                eph_pubkey: pk.into(),
                address: format!("0x{pk}"),
                ctrl: tx,
            },
            rx,
        )
    }

    // Reserve pops distinct bots per game and exhausts the free set.
    #[test]
    fn reserves_distinct_bots_per_game_and_exhausts() {
        let pool = BotPool::default();
        let (b1, _r1) = bot("aa");
        let (b2, _r2) = bot("bb");
        pool.register("blackjack", b1);
        pool.register("blackjack", b2);

        let r1 = pool.reserve("blackjack", 0).expect("one free");
        let r2 = pool.reserve("blackjack", 0).expect("second free");
        assert_ne!(r1.eph_pubkey, r2.eph_pubkey, "distinct bots");
        assert!(pool.reserve("blackjack", 0).is_none(), "pool exhausted");
    }

    // A game with no registered bot yields no reservation (the allocate handler omits it).
    #[test]
    fn reserve_unknown_game_is_none() {
        let pool = BotPool::default();
        assert!(pool.reserve("nope", 0).is_none());
    }

    // An un-opened reservation is reclaimed once past the TTL; an opened one (a live match) is not.
    #[test]
    fn ttl_reclaims_unopened_but_keeps_opened() {
        let pool = BotPool::default();
        let (b1, _r1) = bot("aa");
        pool.register("blackjack", b1);

        let r = pool.reserve("blackjack", 1000).unwrap();
        assert!(
            pool.reserve("blackjack", 1000).is_none(),
            "the only bot is reserved"
        );

        // Not yet expired → still reserved.
        pool.reclaim_expired(1000 + RESERVATION_TTL_MS);
        assert!(
            pool.reserve("blackjack", 0).is_none(),
            "within TTL: still held"
        );

        // Mark the match live, then expire: a live match must NOT be reclaimed.
        assert!(pool.notify(
            &r.match_id,
            FleetServerMsg::Opened {
                match_id: r.match_id.clone(),
                tunnel_id: "0xab".into(),
            }
        ));
        pool.reclaim_expired(1000 + RESERVATION_TTL_MS + 1);
        assert!(
            pool.reserve("blackjack", 0).is_none(),
            "opened match not reclaimed"
        );
    }

    #[test]
    fn ttl_reclaims_unopened_reservation() {
        let pool = BotPool::default();
        let (b1, _r1) = bot("aa");
        pool.register("blackjack", b1);
        let _r = pool.reserve("blackjack", 1000).unwrap();
        pool.reclaim_expired(1000 + RESERVATION_TTL_MS + 1);
        assert!(
            pool.reserve("blackjack", 0).is_some(),
            "unopened reservation reclaimed after TTL"
        );
    }

    // notify routes the control message to the reserved bot's socket sender.
    #[test]
    fn notify_reaches_the_reserved_bot() {
        let pool = BotPool::default();
        let (b1, mut rx) = bot("aa");
        pool.register("blackjack", b1);
        let r = pool.reserve("blackjack", 0).unwrap();

        let msg = FleetServerMsg::Reserved {
            match_id: r.match_id.clone(),
            opponent_wallet: "0xuser".into(),
        };
        assert!(pool.notify(&r.match_id, msg.clone()));
        assert_eq!(rx.try_recv().unwrap(), msg);
        assert!(!pool.notify("nope", msg), "unknown match_id → false");
    }

    // A disconnected bot is removed from both the free set and any reservation it held.
    #[test]
    fn unregister_removes_free_and_reserved() {
        let pool = BotPool::default();
        let (b1, _r1) = bot("aa");
        let id = pool.register("blackjack", b1);
        pool.unregister(id);
        assert!(
            pool.reserve("blackjack", 0).is_none(),
            "an unregistered bot is not allocatable"
        );

        let (b2, _r2) = bot("bb");
        let id2 = pool.register("blackjack", b2);
        let r = pool.reserve("blackjack", 0).unwrap();
        pool.unregister(id2); // bot drops mid-reservation
        assert!(
            !pool.notify(
                &r.match_id,
                FleetServerMsg::Opened {
                    match_id: r.match_id.clone(),
                    tunnel_id: "0xab".into()
                }
            ),
            "the reservation for a dropped bot is gone"
        );
    }

    // The bot's register message decodes; unknown control messages are total (Other).
    #[test]
    fn fleet_client_msg_decodes_register_and_is_total() {
        let reg: FleetClientMsg = serde_json::from_str(
            r#"{"type":"register","game":"blackjack","ephPubkey":"aa","address":"0xbot"}"#,
        )
        .unwrap();
        assert_eq!(
            reg,
            FleetClientMsg::Register {
                game: "blackjack".into(),
                eph_pubkey: "aa".into(),
                address: "0xbot".into(),
            }
        );
        let other: FleetClientMsg = serde_json::from_str(r#"{"type":"surprise"}"#).unwrap();
        assert_eq!(other, FleetClientMsg::Other);
    }
}
