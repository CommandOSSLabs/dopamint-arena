//! The arena's on-chain tunnel-open seam (ADR-0028).
//!
//! In the 1a flow the FLEET (not the user) creates the tunnel + funds seat B at allocate time, so
//! the user's open is a deposit-only PTB and the tunnel activates on a single signature. This trait
//! is that on-chain step. [`NoopArenaOpener`] returns a deterministic placeholder id so the allocate
//! contract and the FE deposit path can be built and tested without chain access; [`SuiArenaOpener`]
//! is the real impl: the bot self-signs `create` (party A = user, party B = bot) + `deposit_party_b`
//! (funding seat B from the bot's SIP-58 MTPS address balance) + `share`, then reads back the shared
//! tunnel id from the tx effects.
//!
//! Per ADR-0028 this makes `allocate` commit the house before the user — so the endpoint that drives
//! it must be authenticated + rate-limited before this ships at scale.

use std::str::FromStr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context};
use async_trait::async_trait;
use base64::Engine;
use sui_crypto::ed25519::Ed25519PrivateKey;
use sui_crypto::SuiSigner;
use sui_sdk_types::{
    Address, Digest, Identifier, Transaction, TransactionExpiration, TypeTag, UserSignature,
};
use sui_transaction_builder::{Function, ObjectInput, TransactionBuilder};

use crate::sui::{
    canonical_address, dryrun_effects_ok, load_ed25519, CHAIN_DIGEST_B58, CLOCK_ADDRESS, GAS_BUDGET,
};

/// What the fleet puts on-chain before the user joins: a tunnel naming the user party A and the bot
/// party B, seat B funded. Both ephemeral pubkeys are baked in at create (the Move `create` requires
/// them), so the user's per-game key must reach here (it rides the allocate request). `stake_each`
/// is the game's per-seat stake (smallest units of `coin_type`); the caller looks it up from the
/// game's `GameProfile` so the off-chain initial balances co-sign with the FE.
pub struct ArenaOpenRequest<'a> {
    pub game: &'a str,
    pub user_address: &'a str,
    pub user_eph_pubkey: &'a str,
    pub bot_address: &'a str,
    pub bot_eph_pubkey: &'a str,
    pub stake_each: u64,
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

/// Tunnel timeout (24h) and penalty, matching the FE PvP open defaults. The bot pre-creates with the
/// same terms the FE would, so a user depositing into this tunnel sees an identical contract.
const ARENA_TUNNEL_TIMEOUT_MS: u64 = 86_400_000;
/// Ed25519 signature scheme code — both party ephemeral keys are ed25519 (the FE's only scheme).
const SIG_SCHEME_ED25519: u8 = 0;

/// The real on-chain opener (ADR-0028). The bot is the sender AND the gas owner (SIP-58 address
/// balance gas, like `submit_close`), so it self-signs the whole PTB — no sponsor, no user
/// signature needed for the open. Seat B is funded from the bot's own MTPS address balance via
/// `coin::redeem_funds`, mirroring the FE's SIP-58 stake path (ADR-0013).
///
/// One opener serves every game (the stake differs per `ArenaOpenRequest`, threaded by the caller);
/// the bot key + RPC/package config are shared across games. Per-game bot accounts are a later
/// hardening — today one funded bot key opens every arena tunnel.
pub struct SuiArenaOpener {
    http: reqwest::Client,
    rpc_url: String,
    package_id: Address,
    coin_type: TypeTag,
    signer: Ed25519PrivateKey,
    sender: Address,
    /// Per-open nonce for the `ValidDuring` FundsWithdrawal replay guard. Same seed rationale as
    /// `SuiSettler::sponsor_nonce` (two restarts in one epoch shouldn't collide).
    open_nonce: AtomicU32,
}

impl SuiArenaOpener {
    /// Build from the shared tunnel config + a funded bot key. The per-seat stake is passed per
    /// request (`ArenaOpenRequest::stake_each`), so one opener serves all games. The bot key is the
    /// funded party-B pool (one key for now; per-game keys are a later hardening).
    pub fn new(
        rpc_url: String,
        package_id: &str,
        coin_type: &str,
        bot_key_b64: &str,
    ) -> anyhow::Result<Self> {
        let signer = load_ed25519(bot_key_b64)?;
        let sender = signer.public_key().derive_address();
        let nonce_seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| (d.as_secs() as u32).wrapping_mul(2_654_435_761).wrapping_add(d.subsec_nanos()))
            .unwrap_or(0);
        Ok(Self {
            http: reqwest::Client::new(),
            rpc_url,
            package_id: Address::from_str(package_id).context("bad TUNNEL_PACKAGE_ID")?,
            coin_type: TypeTag::from_str(coin_type).context("bad TUNNEL_COIN_TYPE")?,
            signer,
            sender,
            open_nonce: AtomicU32::new(nonce_seed),
        })
    }

    async fn rpc(&self, method: &str, params: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let body = serde_json::json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
        let resp: serde_json::Value = self
            .http
            .post(&self.rpc_url)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if let Some(err) = resp.get("error") {
            return Err(anyhow!("rpc {method}: {err}"));
        }
        Ok(resp.get("result").cloned().unwrap_or(serde_json::Value::Null))
    }

    async fn epoch_and_gas_price(&self) -> anyhow::Result<(u64, u64)> {
        let r = self.rpc("suix_getLatestSuiSystemState", serde_json::json!({})).await?;
        let epoch = r
            .pointer("/epoch")
            .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64()))
            .ok_or_else(|| anyhow!("no epoch in system state"))?;
        let gas = r
            .pointer("/referenceGasPrice")
            .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64()))
            .unwrap_or(1);
        Ok((epoch, gas))
    }

    async fn dry_run(&self, tx: &Transaction) -> anyhow::Result<()> {
        let tx_b64 = base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(tx).context("bcs tx")?);
        let r = self.rpc("sui_dryRunTransactionBlock", serde_json::json!([tx_b64])).await?;
        dryrun_effects_ok(&r).map_err(|e| anyhow!("arena open dry-run failed: {e}"))
    }

    /// Execute + return the tx digest AND the shared tunnel object id from the effects' object
    /// changes. The tunnel is the one `shared` object created by this tx (type `...::tunnel::Tunnel<...>`).
    async fn execute_and_read_tunnel(&self, tx: &Transaction, sig: &UserSignature) -> anyhow::Result<String> {
        let b64 = base64::engine::general_purpose::STANDARD;
        let tx_b64 = b64.encode(bcs::to_bytes(tx).context("bcs tx")?);
        let sig_b64 = sig.to_base64();
        let r = self
            .rpc(
                "sui_executeTransactionBlock",
                serde_json::json!([tx_b64, [sig_b64], {"showEffects": true, "showObjectChanges": true}, "WaitForLocalExecution"]),
            )
            .await?;
        if let Some(status) = r.pointer("/effects/status/status").and_then(|v| v.as_str()) {
            anyhow::ensure!(
                status == "success",
                "arena open execution failed: {}",
                r.pointer("/effects/status").map(|v| v.to_string()).unwrap_or_default()
            );
        }
        // The created + shared Tunnel<T> object is the one we want. Object changes list each
        // created object with its type; match the tunnel module's Tunnel type.
        let tunnel_type = format!("{}::tunnel::Tunnel<{}>", self.package_id, self.coin_type);
        let changes = r.pointer("/objectChanges").and_then(|v| v.as_array()).ok_or_else(|| anyhow!("no objectChanges in execute result"))?;
        let mut found = None;
        for ch in changes {
            let kind = ch.pointer("/type").and_then(|v| v.as_str()).unwrap_or("");
            if kind != "created" {
                continue;
            }
            let otype = ch.pointer("/objectType").and_then(|v| v.as_str()).unwrap_or("");
            // The on-chain type string may render with normalized whitespace/casing; match by suffix
            // on the tunnel type to be robust to the package's exact rendering.
            if otype.contains("::tunnel::Tunnel<") {
                let id = ch
                    .pointer("/objectId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow!("tunnel created but no objectId: {ch}"))?;
                found = Some(id.to_string());
                break;
            }
        }
        found.ok_or_else(|| anyhow!("arena open succeeded but no shared Tunnel<{}> in objectChanges (tunnel_type={tunnel_type})", self.coin_type))
    }
}

#[async_trait]
impl ArenaTunnelOpener for SuiArenaOpener {
    async fn open_and_fund_seat_b(&self, req: ArenaOpenRequest<'_>) -> anyhow::Result<String> {
        let user_addr = Address::from_str(&canonical_address(req.user_address)?).context("bad user address")?;
        // The bot's on-chain address is THIS opener's signer's address (self.sender) — it signs +
        // sends the create+deposit PTB, and `deposit_party_b` asserts `ctx.sender() ==
        // tunnel.party_b.address`. The `bot_address` in the request is the fleet's placeholder
        // (a deterministic hash, not a real key) until per-bot KMS keys land; override it with the
        // real funded address so the tunnel's party_b matches the sender.
        let bot_addr = self.sender;
        let user_pk = hex::decode(req.user_eph_pubkey.trim_start_matches("0x"))
            .context("user ephemeral pubkey hex")?;
        let bot_pk = hex::decode(req.bot_eph_pubkey.trim_start_matches("0x"))
            .context("bot ephemeral pubkey hex")?;
        anyhow::ensure!(user_pk.len() == 32, "user ephemeral pubkey must be 32 bytes");
        anyhow::ensure!(bot_pk.len() == 32, "bot ephemeral pubkey must be 32 bytes");

        let (epoch, gas_price) = self.epoch_and_gas_price().await?;
        let chain = Digest::from_base58(CHAIN_DIGEST_B58).context("chain digest")?;
        let nonce = self.open_nonce.fetch_add(1, Ordering::Relaxed);

        let tx = build_arena_open_tx(
            self.package_id,
            self.coin_type.clone(),
            self.sender,
            user_addr,
            user_pk,
            bot_addr,
            bot_pk,
            req.stake_each,
            gas_price,
            epoch,
            chain,
            nonce,
        )?;

        // Verify-before-execute: a dry-run failure (bad pubkeys, insufficient bot balance, wrong
        // package) surfaces here before the bot pays gas.
        self.dry_run(&tx).await?;
        let sig = self
            .signer
            .sign_transaction(&tx)
            .map_err(|e| anyhow!("sign arena open tx: {e}"))?;
        self.execute_and_read_tunnel(&tx, &sig).await
    }
}

/// PURE core: build the bot's seat-B open PTB (offline, no RPC). `create` (party A = user, party B
/// = bot, both ed25519 pubkeys) + `coin::redeem_funds<T>` (seat-B stake from the bot's SIP-58
/// balance) + `deposit_party_b` + `transfer::public_share_object`. SIP-58 address-balance gas
/// (empty gas payment, like `build_close_tx`); the bot is sender AND gas owner. Extracted so the
/// PTB shape is unit-testable without a live node.
#[allow(clippy::too_many_arguments)] // mirrors `build_close_tx`'s offline-build parameter list
fn build_arena_open_tx(
    package_id: Address,
    coin_type: TypeTag,
    sender: Address,
    user_addr: Address,
    user_pk: Vec<u8>,
    bot_addr: Address,
    bot_pk: Vec<u8>,
    stake_each: u64,
    gas_price: u64,
    epoch: u64,
    chain: Digest,
    nonce: u32,
) -> anyhow::Result<Transaction> {
    let mut tb = TransactionBuilder::new();
    // 1. tunnel::create<T>(party_a=user, party_a_pk, sig, party_b=bot, party_b_pk, sig, timeout, penalty, clock)
    // Extract all args first (the builder borrows mutably per call, so inline `tb.pure(..)` inside
    // `tb.move_call(..)` won't compile — same pattern as `build_close_tx`).
    let clock = tb.object(ObjectInput::shared(
        Address::from_str(CLOCK_ADDRESS).expect("static clock id"),
        1,
        false,
    ));
    let a_user = tb.pure(&user_addr);
    let a_user_pk = tb.pure(&user_pk);
    let a_user_sig = tb.pure(&SIG_SCHEME_ED25519);
    let a_bot = tb.pure(&bot_addr);
    let a_bot_pk = tb.pure(&bot_pk);
    let a_bot_sig = tb.pure(&SIG_SCHEME_ED25519);
    let a_timeout = tb.pure(&ARENA_TUNNEL_TIMEOUT_MS);
    let a_penalty = tb.pure(&0u64); // penalty_amount — matches the FE default
    let tunnel = tb.move_call(
        Function::new(
            package_id,
            Identifier::new("tunnel").context("module ident")?,
            Identifier::new("create").context("fn ident")?,
        )
        .with_type_args(vec![coin_type.clone()]),
        vec![
            a_user, a_user_pk, a_user_sig, a_bot, a_bot_pk, a_bot_sig, a_timeout, a_penalty, clock,
        ],
    );
    // 2. coin::redeem_funds<T>(withdrawal{stake, T}) → Coin<T>. The bot funds seat B from its own
    //    SIP-58 address balance (ADR-0013), so no owned coin object to version-pin — concurrent
    //    opens each draw their own reservation and never equivocate.
    let stake_coin = tb.funds_withdrawal_coin(coin_type.clone(), stake_each);
    // 3. tunnel::deposit_party_b<T>(&mut tunnel, coin, clock) — sender must be party_b (the bot).
    let clock2 = tb.object(ObjectInput::shared(
        Address::from_str(CLOCK_ADDRESS).expect("static clock id"),
        1,
        false,
    ));
    tb.move_call(
        Function::new(
            package_id,
            Identifier::new("tunnel").context("module ident")?,
            Identifier::new("deposit_party_b").context("fn ident")?,
        )
        .with_type_args(vec![coin_type.clone()]),
        vec![tunnel, stake_coin, clock2],
    );
    // 4. transfer::public_share_object<Tunnel<T>>(tunnel) — activates the tunnel for both seats.
    //    Needs the `Tunnel<coin_type>` type arg (the object's type), unlike the tunnel module calls
    //    which take `T` alone — mirrors the FE's `typeArguments: ["...::tunnel::Tunnel<coinType>"]`.
    let tunnel_type = format!("{}::tunnel::Tunnel<{}>", package_id, coin_type);
    let tunnel_type_tag: TypeTag = tunnel_type
        .parse()
        .context("parse Tunnel<coin_type> type tag for share")?;
    tb.move_call(
        Function::new(
            Address::from_str("0x2").expect("static framework address"),
            Identifier::new("transfer").context("module ident")?,
            Identifier::new("public_share_object").context("fn ident")?,
        )
        .with_type_args(vec![tunnel_type_tag]),
        vec![tunnel],
    );

    // Placeholder gas satisfies try_build's non-empty-gas check; cleared below (SIP-58
    // address-balance gas, same as build_close_tx — empty objects => withdraw from sender).
    tb.add_gas_objects([ObjectInput::owned(Address::ZERO, 1, Digest::ZERO)]);
    tb.set_sender(sender);
    tb.set_gas_budget(GAS_BUDGET);
    tb.set_gas_price(gas_price.max(1));
    tb.set_expiration(TransactionExpiration::ValidDuring {
        min_epoch: Some(epoch),
        max_epoch: Some(epoch),
        min_timestamp: None,
        max_timestamp: None,
        chain,
        nonce,
    });
    let mut tx = tb.try_build().map_err(|e| anyhow!("build arena open tx: {e}"))?;
    tx.gas_payment.objects.clear();
    Ok(tx)
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
            stake_each: 1000,
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

    // The PTB must carry exactly: create, redeem_funds, deposit_party_b, public_share_object — in
    // that order — and the sender is the bot. Catches a wrong call/target or a reordered open that
    // the Move module would reject on-chain. Offline (no RPC); mirrors build_close_tx's build test.
    #[test]
    fn build_arena_open_tx_has_the_four_expected_calls_in_order() {
        use sui_sdk_types::{Command, MoveCall, TransactionKind};
        let sender = Address::from_str("0xb0b").unwrap();
        let pkg = Address::from_str("0xabc").unwrap();
        let tx = build_arena_open_tx(
            pkg,
            "0xabc::mtps::MTPS".parse().unwrap(),
            sender,
            Address::from_str("0x11").unwrap(),
            vec![0xaa; 32],
            sender,
            vec![0xbb; 32],
            1000,
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            0,
        )
        .unwrap();
        assert_eq!(tx.sender, sender, "bot is the sender (party B deposits)");
        let ptb = match tx.kind {
            TransactionKind::ProgrammableTransaction(p) => p,
            _ => panic!("arena open must be a programmable tx"),
        };
        let calls: Vec<&MoveCall> = ptb
            .commands
            .iter()
            .filter_map(|c| match c {
                Command::MoveCall(mc) => Some(mc),
                _ => None,
            })
            .collect();
        assert_eq!(calls.len(), 4, "exactly four MoveCalls in the open PTB");
        // Sui addresses render zero-padded to 32 bytes; compare by module+function + the parsed pkg.
        let fw = Address::from_str("0x2").unwrap();
        assert_eq!(calls[0].module.to_string(), "tunnel");
        assert_eq!(calls[0].function.to_string(), "create");
        assert_eq!(calls[0].package, pkg);
        assert_eq!(calls[1].module.to_string(), "coin");
        assert_eq!(calls[1].function.to_string(), "redeem_funds");
        assert_eq!(calls[1].package, fw);
        assert_eq!(calls[2].module.to_string(), "tunnel");
        assert_eq!(calls[2].function.to_string(), "deposit_party_b");
        assert_eq!(calls[2].package, pkg);
        assert_eq!(calls[3].module.to_string(), "transfer");
        assert_eq!(calls[3].function.to_string(), "public_share_object");
        assert_eq!(calls[3].package, fw);
    }

    // SIP-58 address-balance gas: the built open tx must carry an EMPTY gas payment so the node
    // charges gas as a FundsWithdrawal from the bot's SUI balance — no owned gas coin to lock, so
    // concurrent opens never equivocate (same invariant as build_close_tx).
    #[test]
    fn build_arena_open_tx_uses_address_balance_gas() {
        let bot = Address::from_str("0xb0b").unwrap();
        let tx = build_arena_open_tx(
            Address::from_str("0xabc").unwrap(),
            "0xabc::mtps::MTPS".parse().unwrap(),
            bot,
            Address::from_str("0x11").unwrap(),
            vec![0xaa; 32],
            bot,
            vec![0xbb; 32],
            1000,
            1000,
            1135,
            Digest::from_base58(CHAIN_DIGEST_B58).unwrap(),
            0,
        )
        .unwrap();
        assert!(
            tx.gas_payment.objects.is_empty(),
            "address-balance gas: gas payment must be empty, got {:?}",
            tx.gas_payment.objects
        );
        assert_eq!(tx.gas_payment.owner, bot);
    }
}
