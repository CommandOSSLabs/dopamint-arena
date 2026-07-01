//! The arena's on-chain tunnel-open seam (ADR-0028).
//!
//! In the 1a flow the FLEET (not the user) creates the tunnel + funds seat B at allocate time, so
//! the user's open is a deposit-only PTB and the tunnel activates on a single signature. This trait
//! is that on-chain step. [`NoopArenaOpener`] returns a deterministic placeholder id so the allocate
//! contract and the FE deposit path can be built and tested without chain access; [`SuiArenaOpener`]
//! is the real impl: it builds `create` (party A = user, party B = bot) + `deposit_party_b` (funding
//! seat B from the bot's SIP-58 MTPS address balance) + `share`, has the settler sponsor the gas
//! (sponsor flow — the bot holds only MTPS, zero SUI), co-signs as the bot, executes, and reads back
//! the shared tunnel id from the tx effects.
//!
//! Per ADR-0028 this makes `allocate` commit the house before the user — so the endpoint that drives
//! it must be authenticated + rate-limited before this ships at scale.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;

use anyhow::{anyhow, Context};
use async_trait::async_trait;
use base64::Engine;
use futures::future::try_join_all;
use sui_crypto::ed25519::Ed25519PrivateKey;
use sui_crypto::SuiSigner;
use sui_sdk_types::{
    Address, Digest, Identifier, Transaction, TransactionKind, TypeTag, UserSignature,
};
use sui_transaction_builder::{Function, ObjectInput, TransactionBuilder};

use crate::sui::{canonical_address, SuiSettler, CLOCK_ADDRESS, GAS_BUDGET};

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

    /// Read the tunnel's on-chain `created_at` (ms) — the same field the FE reads. The co-located bot
    /// signs its settlement half with `timestamp = created_at` to byte-match the FE half (v2 close), so
    /// the relay-bridged anchor resolves this once per match. Kept off `open_and_fund_seat_b`'s return
    /// so a caller with an already-open tunnel (resume/retry) can resolve it without re-opening.
    async fn read_created_at_ms(&self, tunnel_id: &str) -> anyhow::Result<u64>;

    /// Batch N seat-B opens into ONE PTB (allocate-latency fix): a player enters every arena game at
    /// once, so `allocate` opened N tunnels in a serial loop — N on-chain waits back to back. This
    /// collapses them into a single sponsored tx. All N tunnels MUST share the same party-B on-chain
    /// address (`deposit_party_b` asserts `sender == party_b`, and a PTB has one sender), so the caller
    /// checks out one seat-B address for the whole request; per-match identity stays distinct via each
    /// slot's ephemeral pubkey. Returns one result per request, in request order.
    ///
    /// Default = serial (each its own tx), preserving the old per-game drop-on-failure. `SuiArenaOpener`
    /// overrides with the real batched PTB plus a serial fallback, so a batch that aborts as a whole
    /// still opens the games that individually succeed (a single PTB is all-or-nothing).
    async fn open_and_fund_seat_b_many(
        &self,
        reqs: Vec<ArenaOpenRequest<'_>>,
    ) -> Vec<anyhow::Result<String>> {
        let mut out = Vec::with_capacity(reqs.len());
        for req in reqs {
            out.push(self.open_and_fund_seat_b(req).await);
        }
        out
    }
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

    async fn read_created_at_ms(&self, _tunnel_id: &str) -> anyhow::Result<u64> {
        // No chain here: the Noop path never produces a real on-chain close. The FE's `readCreatedAt`
        // on a non-existent placeholder id also resolves to 0, so 0 keeps both halves agreeing.
        Ok(0)
    }
}

/// Tunnel timeout (24h) and penalty, matching the FE PvP open defaults. The bot pre-creates with the
/// same terms the FE would, so a user depositing into this tunnel sees an identical contract.
const ARENA_TUNNEL_TIMEOUT_MS: u64 = 86_400_000;
/// Ed25519 signature scheme code — both party ephemeral keys are ed25519 (the FE's only scheme).
const SIG_SCHEME_ED25519: u8 = 0;

/// Batch read-back retry: after a `WaitForLocalExecution` execute the created tunnels are locally
/// available, so a failed content read is a transient blip, not a missing object. A couple of quick
/// retries avoid failing the whole batch (which would orphan the funded tunnels on the serial re-open).
const READBACK_ATTEMPTS: u8 = 3;
const READBACK_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(150);

/// The real on-chain opener (ADR-0028). The bot is the tx sender (its SIP-58 MTPS address balance
/// funds seat B via `coin::redeem_funds`, mirroring the FE's stake path — ADR-0013), while the
/// SETTLER sponsors the gas (sponsor flow): so the bot holds only MTPS, zero SUI, and the 1M-wallet
/// pool never needs per-wallet SUI funding. The open is co-signed (bot = sender, settler = gas owner)
/// and submitted with both signatures.
///
/// One opener serves every game (the stake differs per `ArenaOpenRequest`, threaded by the caller);
/// the bot key + RPC/package config are shared across games. Per-game bot accounts are a later
/// hardening — today one funded bot key opens every arena tunnel.
pub struct SuiArenaOpener {
    http: reqwest::Client,
    rpc_url: String,
    package_id: Address,
    coin_type: TypeTag,
    /// Funded seat-B wallet pool (PR #124). Each open signs as sender with the member whose address
    /// is party B (`req.bot_address`), so funding + signing spread across the pool instead of one
    /// shared key — removing the single-account nonce bottleneck at the connect spike.
    wallet_pool: std::sync::Arc<crate::wallet::WalletPoolSource>,
    /// Gas sponsor for every open. The settler owns the SIP-58 gas (and stamps the `ValidDuring`
    /// nonce from its own `sponsor_nonce`), so all settler-gas withdrawals — bot opens, faucet,
    /// `/settle`, user sponsors — share one monotonic nonce source and never collide.
    settler: Arc<SuiSettler>,
}

impl SuiArenaOpener {
    /// Build from the shared tunnel config, the funded wallet pool, and the gas-sponsoring settler.
    /// The per-seat stake is passed per request (`ArenaOpenRequest::stake_each`), so one opener serves
    /// all games; the seat-B signer is resolved per open from `req.bot_address`.
    pub fn new(
        rpc_url: String,
        package_id: &str,
        coin_type: &str,
        wallet_pool: std::sync::Arc<crate::wallet::WalletPoolSource>,
        settler: Arc<SuiSettler>,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            http: reqwest::Client::new(),
            rpc_url,
            package_id: Address::from_str(package_id).context("bad TUNNEL_PACKAGE_ID")?,
            coin_type: TypeTag::from_str(coin_type).context("bad TUNNEL_COIN_TYPE")?,
            wallet_pool,
            settler,
        })
    }

    async fn rpc(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
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
        Ok(resp
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    /// Execute the co-signed open + return the shared tunnel object id from the effects' object
    /// changes. The tunnel is the one `shared` object created by this tx (type `...::tunnel::Tunnel<...>`).
    /// `sigs` carries both signatures of the sponsored open — the bot (sender) and the settler (gas
    /// owner); a sponsored tx is rejected unless both are present.
    async fn execute_and_read_tunnel(
        &self,
        tx: &Transaction,
        sigs: &[UserSignature],
    ) -> anyhow::Result<String> {
        let b64 = base64::engine::general_purpose::STANDARD;
        let tx_b64 = b64.encode(bcs::to_bytes(tx).context("bcs tx")?);
        let sigs_b64: Vec<String> = sigs.iter().map(|s| s.to_base64()).collect();
        let r = self
            .rpc(
                "sui_executeTransactionBlock",
                serde_json::json!([tx_b64, sigs_b64, {"showEffects": true, "showObjectChanges": true}, "WaitForLocalExecution"]),
            )
            .await?;
        if let Some(status) = r.pointer("/effects/status/status").and_then(|v| v.as_str()) {
            anyhow::ensure!(
                status == "success",
                "arena open execution failed: {}",
                r.pointer("/effects/status")
                    .map(|v| v.to_string())
                    .unwrap_or_default()
            );
        }
        // The created + shared Tunnel<T> object is the one we want. Object changes list each
        // created object with its type; match the tunnel module's Tunnel type.
        let tunnel_type = format!("{}::tunnel::Tunnel<{}>", self.package_id, self.coin_type);
        let changes = r
            .pointer("/objectChanges")
            .and_then(|v| v.as_array())
            .ok_or_else(|| anyhow!("no objectChanges in execute result"))?;
        let mut found = None;
        for ch in changes {
            let kind = ch.pointer("/type").and_then(|v| v.as_str()).unwrap_or("");
            if kind != "created" {
                continue;
            }
            let otype = ch
                .pointer("/objectType")
                .and_then(|v| v.as_str())
                .unwrap_or("");
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

    /// Open + fund seat B for every request in ONE sponsored PTB, returning the created tunnel ids
    /// aligned to `reqs`. All requests must share one party-B address (the sole tx sender — a batch
    /// gets one seat-B address); each tunnel is correlated back to its request by party-B EPHEMERAL
    /// PUBKEY (distinct per match), read from the created object's content — NOT by address (shared)
    /// and NOT by objectChanges order (unspecified).
    async fn try_batch_open(&self, reqs: &[ArenaOpenRequest<'_>]) -> anyhow::Result<Vec<String>> {
        let bot_address = reqs[0].bot_address;
        anyhow::ensure!(
            reqs.iter().all(|r| r.bot_address == bot_address),
            "batch open requires one shared seat-B address (Design 1)"
        );
        let signer = Ed25519PrivateKey::new(
            self.wallet_pool
                .keypair_for_address(bot_address)?
                .secret_key(),
        );
        let bot_addr = signer.public_key().derive_address();

        // Per-game (user_addr, user_pk, bot_pk, stake); the party-B pubkey is the batch correlation key.
        let mut games = Vec::with_capacity(reqs.len());
        let mut want_pks = Vec::with_capacity(reqs.len());
        for r in reqs {
            let user_addr = Address::from_str(&canonical_address(r.user_address)?)
                .context("bad user address")?;
            let user_pk = hex::decode(r.user_eph_pubkey.trim_start_matches("0x"))
                .context("user ephemeral pubkey hex")?;
            let bot_pk = hex::decode(r.bot_eph_pubkey.trim_start_matches("0x"))
                .context("bot ephemeral pubkey hex")?;
            anyhow::ensure!(
                user_pk.len() == 32,
                "user ephemeral pubkey must be 32 bytes"
            );
            anyhow::ensure!(bot_pk.len() == 32, "bot ephemeral pubkey must be 32 bytes");
            want_pks.push(hex::encode(&bot_pk));
            games.push((user_addr, user_pk, bot_pk, r.stake_each));
        }

        let kind =
            build_arena_open_kind_many(self.package_id, self.coin_type.clone(), bot_addr, &games)?;
        let kind_bytes = bcs::to_bytes(&kind).context("bcs arena batch open kind")?;
        let (tx, settler_sig) = self
            .settler
            .sponsor_arena_open(bot_addr, &kind_bytes)
            .await?;
        let bot_sig = signer
            .sign_transaction(&tx)
            .map_err(|e| anyhow!("sign arena batch open tx: {e}"))?;
        self.execute_and_read_tunnels_by_pubkey(&tx, &[bot_sig, settler_sig], &want_pks)
            .await
    }

    /// Execute the co-signed batch open, then map each created `Tunnel<T>` back to its request by
    /// party-B ephemeral pubkey. Reads each tunnel's content concurrently (one `getObject` per created
    /// tunnel) — with a shared party-B address, neither objectChanges order nor the address can
    /// disambiguate, so the per-match pubkey is the only stable key.
    async fn execute_and_read_tunnels_by_pubkey(
        &self,
        tx: &Transaction,
        sigs: &[UserSignature],
        want_pks: &[String],
    ) -> anyhow::Result<Vec<String>> {
        let b64 = base64::engine::general_purpose::STANDARD;
        let tx_b64 = b64.encode(bcs::to_bytes(tx).context("bcs tx")?);
        let sigs_b64: Vec<String> = sigs.iter().map(|s| s.to_base64()).collect();
        let r = self
            .rpc(
                "sui_executeTransactionBlock",
                serde_json::json!([tx_b64, sigs_b64, {"showEffects": true, "showObjectChanges": true}, "WaitForLocalExecution"]),
            )
            .await?;
        if let Some(status) = r.pointer("/effects/status/status").and_then(|v| v.as_str()) {
            anyhow::ensure!(
                status == "success",
                "arena batch open execution failed: {}",
                r.pointer("/effects/status")
                    .map(|v| v.to_string())
                    .unwrap_or_default()
            );
        }
        let ids = created_tunnel_ids(&r)?;
        anyhow::ensure!(
            ids.len() == want_pks.len(),
            "arena batch open created {} tunnels but expected {}",
            ids.len(),
            want_pks.len()
        );
        let created: Vec<(String, String)> = try_join_all(ids.into_iter().map(|id| async move {
            let pk = self.read_party_b_pubkey(&id).await?;
            Ok::<(String, String), anyhow::Error>((pk, id))
        }))
        .await?;
        align_tunnels_by_pubkey(&created, want_pks)
    }

    /// The party-B ephemeral pubkey (lowercase hex) recorded in a created tunnel's content — the batch
    /// correlation key. Retried briefly: the tunnel was just created by a `WaitForLocalExecution`
    /// execute (so it IS locally available), but a transient read blip here would otherwise fail the
    /// whole batch and orphan the already-funded tunnels via the serial re-open fallback.
    async fn read_party_b_pubkey(&self, tunnel_id: &str) -> anyhow::Result<String> {
        let mut last_err = None;
        for attempt in 0..READBACK_ATTEMPTS {
            match self.read_party_b_pubkey_once(tunnel_id).await {
                Ok(pk) => return Ok(pk),
                Err(e) => {
                    last_err = Some(e);
                    if attempt + 1 < READBACK_ATTEMPTS {
                        tokio::time::sleep(READBACK_RETRY_DELAY).await;
                    }
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("read party_b pubkey for {tunnel_id} failed")))
    }

    async fn read_party_b_pubkey_once(&self, tunnel_id: &str) -> anyhow::Result<String> {
        let r = self
            .rpc(
                "sui_getObject",
                serde_json::json!([tunnel_id, {"showContent": true}]),
            )
            .await?;
        let pk = r
            .pointer("/data/content/fields/party_b/fields/public_key")
            .ok_or_else(|| anyhow!("tunnel {tunnel_id} has no party_b.public_key: {r}"))?;
        pubkey_json_to_hex(pk).ok_or_else(|| {
            anyhow!("tunnel {tunnel_id} party_b.public_key is not a byte vector: {pk}")
        })
    }
}

#[async_trait]
impl ArenaTunnelOpener for SuiArenaOpener {
    async fn open_and_fund_seat_b(&self, req: ArenaOpenRequest<'_>) -> anyhow::Result<String> {
        let user_addr =
            Address::from_str(&canonical_address(req.user_address)?).context("bad user address")?;
        // Seat B is the pool member the fleet checked out (`req.bot_address`). Resolve its key from the
        // funded pool: it is the tx SENDER (its SIP-58 MTPS balance funds seat B, and `deposit_party_b`
        // asserts `ctx.sender() == tunnel.party_b.address`, so sender == party_b == this member), while
        // the settler sponsors the gas — the bot needs no SUI. Signing spreads across the pool.
        let signer = Ed25519PrivateKey::new(
            self.wallet_pool
                .keypair_for_address(req.bot_address)?
                .secret_key(),
        );
        let bot_addr = signer.public_key().derive_address();
        let user_pk = hex::decode(req.user_eph_pubkey.trim_start_matches("0x"))
            .context("user ephemeral pubkey hex")?;
        let bot_pk = hex::decode(req.bot_eph_pubkey.trim_start_matches("0x"))
            .context("bot ephemeral pubkey hex")?;
        anyhow::ensure!(
            user_pk.len() == 32,
            "user ephemeral pubkey must be 32 bytes"
        );
        anyhow::ensure!(bot_pk.len() == 32, "bot ephemeral pubkey must be 32 bytes");

        // Build the open/fund PTB KIND (offline), then hand it to the settler's sponsor wrap — the
        // same allowlist + per-command budget + `sponsor_nonce` as the user `/v1/sponsor` path, so all
        // settler-gas withdrawals share one monotonic nonce. The settler dry-runs (verify-before-gas:
        // bad pubkeys, insufficient bot MTPS, or a drained settler gas balance surface here, before
        // either party pays — the caller then omits this game, ADR-0028) and signs the gas; the bot
        // co-signs as sender.
        let kind = build_arena_open_kind(
            self.package_id,
            self.coin_type.clone(),
            user_addr,
            user_pk,
            bot_addr,
            bot_pk,
            req.stake_each,
        )?;
        let kind_bytes = bcs::to_bytes(&kind).context("bcs arena open kind")?;
        let (tx, settler_sig) = self
            .settler
            .sponsor_arena_open(bot_addr, &kind_bytes)
            .await?;
        let bot_sig = signer
            .sign_transaction(&tx)
            .map_err(|e| anyhow!("sign arena open tx: {e}"))?;
        self.execute_and_read_tunnel(&tx, &[bot_sig, settler_sig])
            .await
    }

    async fn read_created_at_ms(&self, tunnel_id: &str) -> anyhow::Result<u64> {
        let r = self
            .rpc(
                "sui_getObject",
                serde_json::json!([tunnel_id, {"showContent": true}]),
            )
            .await?;
        // The tunnel's `created_at` (ms) — the exact field the FE's `readCreatedAt` reads. Move u64
        // fields render as decimal strings in JSON; tolerate a numeric too.
        r.pointer("/data/content/fields/created_at")
            .and_then(|v| {
                v.as_str()
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| v.as_u64())
            })
            .ok_or_else(|| anyhow!("tunnel {tunnel_id} has no created_at field: {r}"))
    }

    async fn open_and_fund_seat_b_many(
        &self,
        reqs: Vec<ArenaOpenRequest<'_>>,
    ) -> Vec<anyhow::Result<String>> {
        if reqs.is_empty() {
            return Vec::new();
        }
        match self.try_batch_open(&reqs).await {
            Ok(ids) => ids.into_iter().map(Ok).collect(),
            Err(e) => {
                // The batch is one all-or-nothing PTB; a single unfundable/invalid game aborts it.
                // Fall back to per-game opens so the rest still land — matching the pre-batch behavior
                // where a failed open is dropped, not fatal to the whole allocate.
                tracing::warn!("arena batch open failed, retrying serially: {e:#}");
                let mut out = Vec::with_capacity(reqs.len());
                for req in reqs {
                    out.push(self.open_and_fund_seat_b(req).await);
                }
                out
            }
        }
    }
}

/// PURE core: build the bot's seat-B open PTB KIND (offline, no RPC). `create` (party A = user, party
/// B = bot, both ed25519 pubkeys) + `coin::redeem_funds<T>` (seat-B stake withdrawn from the SENDER's
/// SIP-58 balance — the bot) + `deposit_party_b` + `transfer::public_share_object`. Returns only the
/// `TransactionKind`: the settler's sponsor wrap supplies the real sender (bot), SIP-58 gas owner
/// (settler), budget, and expiration — so this is exactly the sponsorable open/fund shape the
/// `/v1/sponsor` allowlist accepts. `pub(crate)` so the sponsorability test can build it.
pub(crate) fn build_arena_open_kind(
    package_id: Address,
    coin_type: TypeTag,
    user_addr: Address,
    user_pk: Vec<u8>,
    bot_addr: Address,
    bot_pk: Vec<u8>,
    stake_each: u64,
) -> anyhow::Result<TransactionKind> {
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

    // Minimal sender/gas/price only to satisfy try_build (it rejects a missing sender/gas); only the
    // resolved `.kind` is kept — the settler re-wraps the real sender, SIP-58 gas owner, budget, and
    // ValidDuring nonce. Sender == bot so the `WithdrawFrom::Sender` stake redeems from the bot.
    tb.add_gas_objects([ObjectInput::owned(Address::ZERO, 1, Digest::ZERO)]);
    tb.set_sender(bot_addr);
    tb.set_gas_budget(GAS_BUDGET);
    tb.set_gas_price(1);
    let tx = tb
        .try_build()
        .map_err(|e| anyhow!("build arena open kind: {e}"))?;
    Ok(tx.kind)
}

/// PURE core: batch N seat-B opens into one PTB KIND (offline). Same per-game shape as
/// [`build_arena_open_kind`] — `create` + `coin::redeem_funds` + `deposit_party_b` +
/// `public_share_object` — repeated per game, all with the SAME party-B address (the sole sender;
/// `deposit_party_b` asserts `sender == party_b`) but each game's own party-A/party-B ephemeral
/// pubkeys and stake. `games` is `(user_addr, user_pk, bot_pk, stake_each)` per game. One Clock input
/// is reused across every command (same shared object). `pub(crate)` so the builder + sponsorability
/// tests can exercise it.
pub(crate) fn build_arena_open_kind_many(
    package_id: Address,
    coin_type: TypeTag,
    bot_addr: Address,
    games: &[(Address, Vec<u8>, Vec<u8>, u64)],
) -> anyhow::Result<TransactionKind> {
    anyhow::ensure!(!games.is_empty(), "batch open needs at least one game");
    let mut tb = TransactionBuilder::new();
    let clock = tb.object(ObjectInput::shared(
        Address::from_str(CLOCK_ADDRESS).expect("static clock id"),
        1,
        false,
    ));
    let tunnel_type: TypeTag = format!("{}::tunnel::Tunnel<{}>", package_id, coin_type)
        .parse()
        .context("parse Tunnel<coin_type> type tag for share")?;
    let framework = Address::from_str("0x2").expect("static framework address");
    for (user_addr, user_pk, bot_pk, stake) in games {
        let a_user = tb.pure(user_addr);
        let a_user_pk = tb.pure(user_pk);
        let a_user_sig = tb.pure(&SIG_SCHEME_ED25519);
        let a_bot = tb.pure(&bot_addr);
        let a_bot_pk = tb.pure(bot_pk);
        let a_bot_sig = tb.pure(&SIG_SCHEME_ED25519);
        let a_timeout = tb.pure(&ARENA_TUNNEL_TIMEOUT_MS);
        let a_penalty = tb.pure(&0u64);
        let tunnel = tb.move_call(
            Function::new(
                package_id,
                Identifier::new("tunnel").context("module ident")?,
                Identifier::new("create").context("fn ident")?,
            )
            .with_type_args(vec![coin_type.clone()]),
            vec![
                a_user, a_user_pk, a_user_sig, a_bot, a_bot_pk, a_bot_sig, a_timeout, a_penalty,
                clock,
            ],
        );
        let stake_coin = tb.funds_withdrawal_coin(coin_type.clone(), *stake);
        tb.move_call(
            Function::new(
                package_id,
                Identifier::new("tunnel").context("module ident")?,
                Identifier::new("deposit_party_b").context("fn ident")?,
            )
            .with_type_args(vec![coin_type.clone()]),
            vec![tunnel, stake_coin, clock],
        );
        tb.move_call(
            Function::new(
                framework,
                Identifier::new("transfer").context("module ident")?,
                Identifier::new("public_share_object").context("fn ident")?,
            )
            .with_type_args(vec![tunnel_type.clone()]),
            vec![tunnel],
        );
    }
    tb.add_gas_objects([ObjectInput::owned(Address::ZERO, 1, Digest::ZERO)]);
    tb.set_sender(bot_addr);
    tb.set_gas_budget(GAS_BUDGET);
    tb.set_gas_price(1);
    let tx = tb
        .try_build()
        .map_err(|e| anyhow!("build arena batch open kind: {e}"))?;
    Ok(tx.kind)
}

/// Every created `Tunnel<T>` object id in a tx execute result's objectChanges (kind `created`, type
/// suffix `::tunnel::Tunnel<`). The single-open reader takes only the first; a batch creates N.
fn created_tunnel_ids(result: &serde_json::Value) -> anyhow::Result<Vec<String>> {
    let changes = result
        .pointer("/objectChanges")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow!("no objectChanges in execute result"))?;
    let mut ids = Vec::new();
    for ch in changes {
        if ch.pointer("/type").and_then(|v| v.as_str()) != Some("created") {
            continue;
        }
        let otype = ch
            .pointer("/objectType")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if otype.contains("::tunnel::Tunnel<") {
            let id = ch
                .pointer("/objectId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("tunnel created but no objectId: {ch}"))?;
            ids.push(id.to_string());
        }
    }
    Ok(ids)
}

/// A Move `vector<u8>` field (JSON-RPC renders it as an array of byte numbers; tolerate a hex string
/// too) to lowercase hex, matching the `hex::encode`d pubkeys the requests carry.
fn pubkey_json_to_hex(v: &serde_json::Value) -> Option<String> {
    if let Some(arr) = v.as_array() {
        let bytes: Option<Vec<u8>> = arr
            .iter()
            .map(|x| x.as_u64().and_then(|n| u8::try_from(n).ok()))
            .collect();
        return bytes.map(hex::encode);
    }
    if let Some(s) = v.as_str() {
        let s = s.trim_start_matches("0x");
        if hex::decode(s).is_ok() {
            return Some(s.to_lowercase());
        }
    }
    None
}

/// Align created `(party_b_pubkey_hex, tunnel_id)` pairs to the requested pubkey order. The key is the
/// party-B ephemeral pubkey — distinct per match even though the batch shares one party-B address.
/// Errors if the counts differ or a requested pubkey has no created tunnel: a silent misalignment
/// would hand a user someone else's tunnel.
fn align_tunnels_by_pubkey(
    created: &[(String, String)],
    want_pks: &[String],
) -> anyhow::Result<Vec<String>> {
    anyhow::ensure!(
        created.len() == want_pks.len(),
        "batch open created {} tunnels but expected {}",
        created.len(),
        want_pks.len()
    );
    let by_pk: HashMap<String, &str> = created
        .iter()
        .map(|(pk, id)| (pk.to_lowercase(), id.as_str()))
        .collect();
    want_pks
        .iter()
        .map(|pk| {
            by_pk
                .get(&pk.to_lowercase())
                .map(|id| id.to_string())
                .ok_or_else(|| anyhow!("batch open: no created tunnel matched party_b pubkey {pk}"))
        })
        .collect()
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

    // The KIND must carry exactly: create, redeem_funds, deposit_party_b, public_share_object — in
    // that order. Catches a wrong call/target or a reordered open that the Move module would reject
    // on-chain. Offline (no RPC). Sponsorability (sender-sourced stake, settler gas) is proved by
    // `arena_open_kind_is_sponsorable_*` in `sui.rs`, where the sponsor validator lives.
    #[test]
    fn build_arena_open_kind_has_the_four_expected_calls_in_order() {
        use sui_sdk_types::{Command, MoveCall, TransactionKind};
        let pkg = Address::from_str("0xabc").unwrap();
        let bot = Address::from_str("0xb0b").unwrap();
        let kind = build_arena_open_kind(
            pkg,
            "0xabc::mtps::MTPS".parse().unwrap(),
            Address::from_str("0x11").unwrap(),
            vec![0xaa; 32],
            bot,
            vec![0xbb; 32],
            1000,
        )
        .unwrap();
        let ptb = match kind {
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

    // A batched open must carry each game's four calls, in order, back to back — the same per-game
    // shape as the single open, just repeated. A reordered/short batch is one the Move module would
    // reject on-chain, or (worse) a game silently dropped from the PTB.
    #[test]
    fn build_arena_open_kind_many_has_four_calls_per_game_in_order() {
        use sui_sdk_types::{Command, MoveCall, TransactionKind};
        let pkg = Address::from_str("0xabc").unwrap();
        let bot = Address::from_str("0xb0b").unwrap();
        let games = vec![
            (
                Address::from_str("0x11").unwrap(),
                vec![0xa1; 32],
                vec![0xb1; 32],
                1000u64,
            ),
            (
                Address::from_str("0x22").unwrap(),
                vec![0xa2; 32],
                vec![0xb2; 32],
                2000u64,
            ),
        ];
        let kind =
            build_arena_open_kind_many(pkg, "0xabc::mtps::MTPS".parse().unwrap(), bot, &games)
                .unwrap();
        let ptb = match kind {
            TransactionKind::ProgrammableTransaction(p) => p,
            _ => panic!("batch open must be a programmable tx"),
        };
        let calls: Vec<&MoveCall> = ptb
            .commands
            .iter()
            .filter_map(|c| match c {
                Command::MoveCall(mc) => Some(mc),
                _ => None,
            })
            .collect();
        assert_eq!(calls.len(), 8, "four MoveCalls per game × two games");
        let fw = Address::from_str("0x2").unwrap();
        for g in 0..2 {
            let base = g * 4;
            assert_eq!(calls[base].module.to_string(), "tunnel");
            assert_eq!(calls[base].function.to_string(), "create");
            assert_eq!(calls[base].package, pkg);
            assert_eq!(calls[base + 1].module.to_string(), "coin");
            assert_eq!(calls[base + 1].function.to_string(), "redeem_funds");
            assert_eq!(calls[base + 1].package, fw);
            assert_eq!(calls[base + 2].module.to_string(), "tunnel");
            assert_eq!(calls[base + 2].function.to_string(), "deposit_party_b");
            assert_eq!(calls[base + 3].module.to_string(), "transfer");
            assert_eq!(calls[base + 3].function.to_string(), "public_share_object");
            assert_eq!(calls[base + 3].package, fw);
        }
    }

    // The load-bearing invariant: with a shared party-B ADDRESS, the created tunnels must be matched
    // to requests by party-B PUBKEY, never by position. The created list here is out of request order
    // to prove the map (not the index) is what aligns them — a position-based match would hand game A
    // game B's tunnel.
    #[test]
    fn align_tunnels_by_pubkey_maps_each_request_to_its_own_tunnel() {
        let created = vec![
            ("bb".repeat(32), "0xtunnelB".to_string()),
            ("aa".repeat(32), "0xtunnelA".to_string()),
        ];
        let want = vec!["aa".repeat(32), "bb".repeat(32)];
        let got = align_tunnels_by_pubkey(&created, &want).unwrap();
        assert_eq!(
            got,
            vec!["0xtunnelA".to_string(), "0xtunnelB".to_string()],
            "each request resolves to the tunnel carrying ITS pubkey, regardless of created order"
        );
    }

    // A requested pubkey with no created tunnel must error, not silently drop or mismatch — returning
    // the wrong tunnel id would fund the wrong game's seat A.
    #[test]
    fn align_tunnels_by_pubkey_errors_on_a_missing_pubkey() {
        let created = vec![("aa".repeat(32), "0xtunnelA".to_string())];
        let want = vec!["cc".repeat(32)];
        assert!(align_tunnels_by_pubkey(&created, &want).is_err());
    }

    // Sui JSON-RPC renders a Move `vector<u8>` as an array of byte numbers; the correlation key is its
    // hex, so the reader must round-trip bytes → the same hex the request holds.
    #[test]
    fn pubkey_json_to_hex_reads_a_byte_array() {
        let v = serde_json::json!([1, 2, 255]);
        assert_eq!(pubkey_json_to_hex(&v).unwrap(), "0102ff");
    }

    // The batch reader must collect EVERY created tunnel (not just the first, as the single-open
    // reader does) and skip mutated/other objects.
    #[test]
    fn created_tunnel_ids_collects_all_created_tunnels() {
        let r = serde_json::json!({"objectChanges": [
            {"type": "created", "objectType": "0xabc::tunnel::Tunnel<0xabc::mtps::MTPS>", "objectId": "0x1"},
            {"type": "mutated", "objectType": "0x2::coin::Coin<0xabc::mtps::MTPS>", "objectId": "0x9"},
            {"type": "created", "objectType": "0xabc::tunnel::Tunnel<0xabc::mtps::MTPS>", "objectId": "0x2"}
        ]});
        assert_eq!(
            created_tunnel_ids(&r).unwrap(),
            vec!["0x1".to_string(), "0x2".to_string()]
        );
    }
}
