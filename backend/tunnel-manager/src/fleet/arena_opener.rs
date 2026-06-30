//! The arena's on-chain tunnel-open seam (ADR-0028).
//!
//! In the 1a flow the FLEET (not the user) creates the tunnel + funds seat B at allocate time, so
//! the user's open is a deposit-only PTB and the tunnel activates on a single signature. This trait
//! is that on-chain step. [`NoopArenaOpener`] returns a deterministic placeholder id so the allocate
//! contract and the FE deposit path can be built and tested without chain access; the real
//! `create_and_share` (naming `party_a = user`) + `deposit_party_b` is the boss's `SuiAnchor` impl.
//!
//! Per ADR-0028 this makes `allocate` commit the house before the user — so the endpoint that drives
//! it must be authenticated + rate-limited before this ships at scale.

use async_trait::async_trait;

/// What the fleet puts on-chain before the user joins: a tunnel naming the user party A and the bot
/// party B, seat B funded. Both ephemeral pubkeys are baked in at create (the Move `create` requires
/// them), so the user's per-game key must reach here (it rides the allocate request).
pub struct ArenaOpenRequest<'a> {
    pub game: &'a str,
    pub user_address: &'a str,
    pub user_eph_pubkey: &'a str,
    pub bot_address: &'a str,
    pub bot_eph_pubkey: &'a str,
}

#[async_trait]
pub trait ArenaTunnelOpener: Send + Sync {
    /// Create the shared tunnel (party A = user, party B = bot) and fund seat B, returning the
    /// on-chain tunnel id the user will `deposit_party_a` into. On-chain-bound and may fail per
    /// game; the caller omits a game whose open errors (ADR-0028).
    async fn open_and_fund_seat_b(&self, req: ArenaOpenRequest<'_>) -> anyhow::Result<String>;
}

/// Placeholder opener: a deterministic id derived from the request, no chain access. Lets the 1a
/// contract + FE deposit path land ahead of the real `SuiAnchor` (ADR-0028 scaffold). The id is NOT
/// a real object id — it only needs to be stable and distinct per (user, bot, game) for the wiring.
#[derive(Default)]
pub struct NoopArenaOpener;

#[async_trait]
impl ArenaTunnelOpener for NoopArenaOpener {
    async fn open_and_fund_seat_b(&self, req: ArenaOpenRequest<'_>) -> anyhow::Result<String> {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        req.game.hash(&mut h);
        req.user_address.hash(&mut h);
        req.user_eph_pubkey.hash(&mut h);
        req.bot_address.hash(&mut h);
        req.bot_eph_pubkey.hash(&mut h);
        Ok(format!("0xnoop{:016x}", h.finish()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req<'a>(game: &'a str, user: &'a str) -> ArenaOpenRequest<'a> {
        ArenaOpenRequest {
            game,
            user_address: user,
            user_eph_pubkey: "ueph",
            bot_address: "0xbot",
            bot_eph_pubkey: "beph",
        }
    }

    // The placeholder id is stable for a given request and distinct across game/user — enough for
    // the allocate contract + FE deposit path to be wired and tested before SuiAnchor.
    #[tokio::test]
    async fn noop_id_is_deterministic_and_distinct() {
        let opener = NoopArenaOpener;
        let a = opener
            .open_and_fund_seat_b(req("blackjack", "0xu"))
            .await
            .unwrap();
        let a2 = opener
            .open_and_fund_seat_b(req("blackjack", "0xu"))
            .await
            .unwrap();
        let b = opener
            .open_and_fund_seat_b(req("caro", "0xu"))
            .await
            .unwrap();
        let c = opener
            .open_and_fund_seat_b(req("blackjack", "0xother"))
            .await
            .unwrap();
        assert_eq!(a, a2, "same request → same id");
        assert_ne!(a, b, "different game → different id");
        assert_ne!(a, c, "different user → different id");
        assert!(a.starts_with("0xnoop"), "placeholder, not a real object id");
    }
}
