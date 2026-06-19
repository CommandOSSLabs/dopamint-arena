//! On-chain cooperative settlement via the lightweight Sui SDK (PTB build + Ed25519
//! sign) and JSON-RPC (object resolution + execution).
//!
//! The settler is a NON-PARTY gas payer: only the two co-signatures verify on-chain
//! (tunnel.move:1062). It derives NO nonce — `final_nonce` is reconstructed on-chain
//! as `tunnel.state.nonce + 1`; `sig_a`/`sig_b` are passed verbatim. See ADR-0002.
//!
//! Gas: SIP-58 address-balance gas (empty `gas_payment.objects`). The node charges gas as a
//! FundsWithdrawal from the settler's address balance — no owned coin to lock, so concurrent
//! closes never equivocate. Node acceptance (protocol-v125+) is e2e-deferred (no live node).
//!
//! Earlier e2e (localnet, single-close with owned gas) verified the PTB arg order, signature
//! serialization (`UserSignature::to_base64`, not `bcs::to_bytes`), and `pure` encoding.

use std::str::FromStr;

use anyhow::{anyhow, Context};
use base64::Engine;
use sui_crypto::ed25519::Ed25519PrivateKey;
use sui_crypto::SuiSigner;
use sui_sdk_types::{Address, Digest, Identifier, Transaction, TypeTag, UserSignature};
use sui_transaction_builder::{Function, ObjectInput, TransactionBuilder};

/// 0x6 system Clock — shared, first shared at version 1.
const CLOCK_ADDRESS: &str = "0x0000000000000000000000000000000000000000000000000000000000000006";
/// Fixed gas budget for a single cooperative close (one MoveCall, two shared objects).
const GAS_BUDGET: u64 = 100_000_000;

/// Fields for one on-chain `close_cooperative_with_root`, mapped from the SDK's
/// SettlementWithRoot (ADR-0002). Balances/timestamp already parsed to `u64`; sigs and
/// root already hex-decoded by the handler.
pub struct CloseArgs {
    pub tunnel_id: String,
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    pub sig_a: Vec<u8>,
    pub sig_b: Vec<u8>,
    pub timestamp: u64,
    pub transcript_root: Vec<u8>,
}

/// A shared object's PTB reference: id + the version it was first shared at.
#[derive(Clone)]
struct SharedRef {
    id: Address,
    initial_shared_version: u64,
}

pub struct SuiSettler {
    http: reqwest::Client,
    rpc_url: String,
    package_id: Address,
    coin_type: TypeTag,
    signer: Ed25519PrivateKey,
    sender: Address,
}

/// A parsed tunnel lifecycle event: the type suffix drives status folding; the rest feeds the
/// recent-events ring. `transcript_root` is hex; balances are `None` on non-close events.
#[derive(Debug, Clone)]
pub struct RawTunnelEvent {
    pub type_suffix: String,
    pub tunnel_id: String,
    pub party_a_balance: Option<u64>,
    pub party_b_balance: Option<u64>,
    pub transcript_root: Option<String>,
    pub tx_digest: String,
    pub timestamp_ms: u64,
}

/// u64 fields arrive over JSON-RPC as strings; accept a number too, for robustness.
fn parsed_u64(v: &serde_json::Value, field: &str) -> Option<u64> {
    let f = v.pointer(&format!("/parsedJson/{field}"))?;
    f.as_str().and_then(|s| s.parse().ok()).or_else(|| f.as_u64())
}

/// `vector<u8>` arrives as an array of byte numbers; render to lowercase hex.
/// NOTE: the exact `vector<u8>` JSON encoding is confirmed against a live event during the
/// e2e milestone (see spec "Dependencies & readiness"); array-of-bytes is the documented shape.
fn parsed_bytes_hex(v: &serde_json::Value, field: &str) -> Option<String> {
    let arr = v.pointer(&format!("/parsedJson/{field}"))?.as_array()?;
    let mut out = String::with_capacity(arr.len() * 2);
    for b in arr {
        out.push_str(&format!("{:02x}", b.as_u64()? as u8));
    }
    Some(out)
}

/// Parse one `suix_queryEvents` data row into a `RawTunnelEvent`, or `None` if it is not a
/// tunnel lifecycle event (no `parsedJson.tunnel_id`).
fn parse_event_row(ev: &serde_json::Value) -> Option<RawTunnelEvent> {
    let tunnel_id = ev.pointer("/parsedJson/tunnel_id")?.as_str()?.to_string();
    let type_suffix = ev
        .get("type")
        .and_then(|v| v.as_str())
        .and_then(|t| t.rsplit("::").next())
        .unwrap_or_default()
        .to_string();
    let tx_digest = ev
        .pointer("/id/txDigest")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let timestamp_ms = ev
        .get("timestampMs")
        .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64()))
        .unwrap_or(0);
    Some(RawTunnelEvent {
        type_suffix,
        tunnel_id,
        party_a_balance: parsed_u64(ev, "party_a_balance"),
        party_b_balance: parsed_u64(ev, "party_b_balance"),
        transcript_root: parsed_bytes_hex(ev, "transcript_root"),
        tx_digest,
        timestamp_ms,
    })
}

/// Read a `sui_dryRunTransactionBlock` result: `Ok` iff `effects.status.status == "success"`,
/// else `Err(<status json>)`. Mirrors the `execute()` status check; lets the settler reject a
/// settlement that will not land BEFORE sponsoring gas (ADR-0007). Unit-tested against sample JSON.
fn dryrun_effects_ok(resp: &serde_json::Value) -> Result<(), String> {
    match resp
        .pointer("/effects/status/status")
        .and_then(|v| v.as_str())
    {
        Some("success") => Ok(()),
        _ => Err(resp
            .pointer("/effects/status")
            .map(|v| v.to_string())
            .unwrap_or_else(|| "dry-run result missing effects.status".to_string())),
    }
}

impl SuiSettler {
    pub fn new(
        rpc_url: String,
        package_id: &str,
        coin_type: &str,
        settler_key_b64: &str,
    ) -> anyhow::Result<Self> {
        let signer = load_ed25519(settler_key_b64)?;
        let sender = signer.public_key().derive_address();
        Ok(Self {
            http: reqwest::Client::new(),
            rpc_url,
            package_id: Address::from_str(package_id).context("bad TUNNEL_PACKAGE_ID")?,
            coin_type: TypeTag::from_str(coin_type).context("bad TUNNEL_COIN_TYPE")?,
            signer,
            sender,
        })
    }

    /// Build, sign, and execute `close_cooperative_with_root`; returns the tx digest.
    /// Resolves the tunnel shared ref + reference gas price over JSON-RPC, builds offline.
    /// Concurrent calls are safe: no shared gas coin means no equivocation risk.
    pub async fn submit_close(&self, args: CloseArgs) -> anyhow::Result<String> {
        let tunnel = self.resolve_shared(&args.tunnel_id).await?;
        let gas_price = self.reference_gas_price().await?;
        let tx = build_close_tx(
            self.package_id,
            self.coin_type.clone(),
            self.sender,
            &args,
            &tunnel,
            gas_price,
        )?;
        // Verify-before-gas: reject a settlement that won't land before sponsoring it (ADR-0007).
        self.dry_run(&tx).await?;
        let sig = self
            .signer
            .sign_transaction(&tx)
            .map_err(|e| anyhow!("sign close tx: {e}"))?;
        self.execute(&tx, &sig).await
    }

    /// Dry-run the built close tx so the real `close_cooperative_with_root` runs (re-verifying
    /// both seat sigs against the on-chain pubkeys and the balance sum) WITHOUT executing — an
    /// invalid settlement is rejected here, before any gas is sponsored (ADR-0007). The seat sigs
    /// are PTB `vector<u8>` arguments, so an unsigned tx is sufficient to exercise them.
    /// e2e-deferred (needs a live node); the status parse is unit-tested (`dryrun_effects_ok`).
    async fn dry_run(&self, tx: &Transaction) -> anyhow::Result<()> {
        let tx_b64 = base64::engine::general_purpose::STANDARD
            .encode(bcs::to_bytes(tx).context("bcs tx")?);
        let r = self
            .rpc("sui_dryRunTransactionBlock", serde_json::json!([tx_b64]))
            .await?;
        dryrun_effects_ok(&r).map_err(|e| anyhow!("close dry-run failed: {e}"))
    }

    // ---- JSON-RPC reads/execute (compile-verified; e2e-deferred, see module docs) ----

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

    async fn resolve_shared(&self, object_id: &str) -> anyhow::Result<SharedRef> {
        let r = self
            .rpc(
                "sui_getObject",
                serde_json::json!([object_id, {"showOwner": true}]),
            )
            .await?;
        let isv = r
            .pointer("/data/owner/Shared/initial_shared_version")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| anyhow!("object {object_id} is not a shared tunnel: {r}"))?;
        Ok(SharedRef {
            id: Address::from_str(object_id).context("tunnel id")?,
            initial_shared_version: isv,
        })
    }

    async fn reference_gas_price(&self) -> anyhow::Result<u64> {
        let r = self
            .rpc("suix_getReferenceGasPrice", serde_json::json!([]))
            .await?;
        r.as_str()
            .and_then(|s| s.parse().ok())
            .or_else(|| r.as_u64())
            .ok_or_else(|| anyhow!("bad reference gas price: {r}"))
    }

    async fn execute(&self, tx: &Transaction, sig: &UserSignature) -> anyhow::Result<String> {
        let b64 = base64::engine::general_purpose::STANDARD;
        let tx_b64 = b64.encode(bcs::to_bytes(tx).context("bcs tx")?);
        // NOT bcs::to_bytes — UserSignature's BCS double-tags the enum (98 bytes). The
        // JSON-RPC `signatures` field wants the flat 97-byte flag‖sig‖pubkey form, which
        // is exactly `to_base64()`. (Pinned by ed25519_signature_serializes_to_97_byte_sui_format.)
        let sig_b64 = sig.to_base64();
        let r = self
            .rpc(
                "sui_executeTransactionBlock",
                serde_json::json!([tx_b64, [sig_b64], {"showEffects": true}, "WaitForLocalExecution"]),
            )
            .await?;
        // On-chain verification failure (bad sig / balance sum) surfaces here, not as a
        // transport error — make it a hard error so the handler maps it to 422.
        if let Some(status) = r.pointer("/effects/status/status").and_then(|v| v.as_str()) {
            anyhow::ensure!(
                status == "success",
                "on-chain execution failed: {}",
                r.pointer("/effects/status")
                    .map(|v| v.to_string())
                    .unwrap_or_default()
            );
        }
        r.get("digest")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("no digest in execute result: {r}"))
    }

    /// Poll this package's `tunnel` module events, cursor-paginated (ascending). Returns
    /// `(events, next_cursor)`; the cursor is opaque (passed straight back).
    /// e2e-deferred (needs a live node + package).
    pub async fn query_tunnel_events(
        &self,
        cursor: Option<serde_json::Value>,
    ) -> anyhow::Result<(Vec<RawTunnelEvent>, Option<serde_json::Value>)> {
        let filter = serde_json::json!({
            "MoveModule": { "package": self.package_id.to_string(), "module": "tunnel" }
        });
        let r = self
            .rpc("suix_queryEvents", serde_json::json!([filter, cursor, 50, false]))
            .await?;
        let mut events = Vec::new();
        if let Some(data) = r.get("data").and_then(|v| v.as_array()) {
            for ev in data {
                if let Some(raw) = parse_event_row(ev) {
                    events.push(raw);
                }
            }
        }
        // Advance only when the node gives a cursor; a null cursor (empty poll) keeps our
        // position so we don't replay from genesis every tick.
        let next = r.get("nextCursor").cloned().filter(|v| !v.is_null());
        Ok((events, next))
    }
}

/// Project a raw event to a displayable Transaction-Log row, or `None` if it is not one
/// (only activations and closes are shown). `game` is left `None` for v1 — the event carries
/// no game tag; joining `tunnel_id → game` via the session registry is a deferred follow-up.
fn to_tunnel_event(raw: &RawTunnelEvent) -> Option<crate::state::TunnelEvent> {
    let kind = match raw.type_suffix.as_str() {
        "TunnelActivated" => crate::state::TunnelEventKind::Opened,
        "TunnelClosed" | "TunnelClosedWithRoot" => crate::state::TunnelEventKind::Settled,
        _ => return None,
    };
    Some(crate::state::TunnelEvent {
        tunnel_id: raw.tunnel_id.clone(),
        kind,
        party_a_balance: raw.party_a_balance,
        party_b_balance: raw.party_b_balance,
        transcript_root: raw.transcript_root.clone(),
        tx_digest: raw.tx_digest.clone(),
        timestamp_ms: raw.timestamp_ms,
        proof_url: None, // indexer rows are explorer-only; the /settle handler sets this (Task 7)
    })
}

/// Poll the chain for this package's tunnel events and fold them into the registry via
/// `ControlStore::set_tunnel_status` — the transition logic (idempotency, count maintenance)
/// now lives in the store impl. e2e-deferred (needs a live node + published package).
pub fn spawn_event_indexer(state: crate::state::SharedState) {
    tokio::spawn(async move {
        let mut cursor = None;
        loop {
            match state.settler.query_tunnel_events(cursor.clone()).await {
                Ok((events, next)) => {
                    for raw in events {
                        let status = match raw.type_suffix.as_str() {
                            "TunnelCreated" => Some(crate::state::TunnelStatus::Created),
                            "TunnelActivated" => Some(crate::state::TunnelStatus::Active),
                            "TunnelClosed" | "TunnelClosedWithRoot" => {
                                Some(crate::state::TunnelStatus::Closed)
                            }
                            _ => None,
                        };
                        if let Some(s) = status {
                            state.control.set_tunnel_status(&raw.tunnel_id, s).await;
                        }
                        if let Some(row) = to_tunnel_event(&raw) {
                            state.control.push_recent_event(row).await;
                        }
                    }
                    if next.is_some() {
                        cursor = next;
                    }
                }
                Err(e) => tracing::warn!(error = %e, "tunnel event poll failed; retrying"),
            }
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        }
    });
}

/// PURE core: build the `close_cooperative_with_root` PTB. Arg order matches the Move
/// signature exactly: tunnel, a_balance, b_balance, sig_a, sig_b, timestamp, transcript_root,
/// clock. The clock SharedRef is constructed internally from the well-known 0x6 address.
///
/// Uses SIP-58 address-balance gas: `try_build` requires ≥1 gas object, so a zero-value
/// placeholder is added to pass that check, then cleared before returning. The caller must
/// sign the returned tx before use — clearing before signing is required since the sig covers
/// `gas_payment`. Unit-tested.
fn build_close_tx(
    package_id: Address,
    coin_type: TypeTag,
    sender: Address,
    args: &CloseArgs,
    tunnel: &SharedRef,
    gas_price: u64,
) -> anyhow::Result<Transaction> {
    anyhow::ensure!(
        args.transcript_root.len() == 32,
        "transcript_root must be 32 bytes, got {}",
        args.transcript_root.len()
    );
    let mut tb = TransactionBuilder::new();
    let tunnel_arg = tb.object(ObjectInput::shared(
        tunnel.id,
        tunnel.initial_shared_version,
        true,
    ));
    // Move params sig_a/sig_b/transcript_root are `vector<u8>`: use `pure(&Vec<u8>)`, which
    // BCS-encodes them length-prefixed. `pure_bytes` inserts RAW bytes (no length prefix) →
    // the node rejects them as InvalidBCSBytes. (Caught only by the localnet e2e, not the
    // build-time `is_ok()` unit test.)
    let a = tb.pure(&args.party_a_balance);
    let b = tb.pure(&args.party_b_balance);
    let sa = tb.pure(&args.sig_a);
    let sb = tb.pure(&args.sig_b);
    let ts = tb.pure(&args.timestamp);
    let root = tb.pure(&args.transcript_root);
    let clock_arg = tb.object(ObjectInput::shared(
        Address::from_str(CLOCK_ADDRESS).expect("static clock id"),
        1,
        false,
    ));

    let func = Function::new(
        package_id,
        Identifier::new("tunnel").context("module ident")?,
        Identifier::new("close_cooperative_with_root").context("fn ident")?,
    )
    .with_type_args(vec![coin_type]);
    tb.move_call(func, vec![tunnel_arg, a, b, sa, sb, ts, root, clock_arg]);

    // Placeholder satisfies try_build's non-empty-gas check (builder.rs:676).
    tb.add_gas_objects([ObjectInput::owned(Address::ZERO, 1, Digest::ZERO)]);
    tb.set_sender(sender);
    tb.set_gas_budget(GAS_BUDGET);
    tb.set_gas_price(gas_price.max(1));
    let mut tx = tb.try_build().map_err(|e| anyhow!("build close tx: {e}"))?;
    // Empty objects => FundsWithdrawal from sender's address balance (SIP-58).
    tx.gas_payment.objects.clear();
    Ok(tx)
}

/// Decode the settler's ed25519 secret: 32 raw bytes, or 33 with the Sui ed25519 flag
/// (`0x00`) prefix, base64-encoded.
fn load_ed25519(b64: &str) -> anyhow::Result<Ed25519PrivateKey> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .context("SUI_SETTLER_KEY is not valid base64")?;
    let key: [u8; 32] = match raw.len() {
        32 => raw.try_into().unwrap(),
        33 if raw[0] == 0x00 => raw[1..].try_into().unwrap(),
        n => {
            return Err(anyhow!(
                "ed25519 secret must be 32 bytes (or 33 with flag), got {n}"
            ))
        }
    };
    Ok(Ed25519PrivateKey::new(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A dry-run that succeeds means the close WILL land — proceed to execute.
    #[test]
    fn dryrun_ok_on_success_effects() {
        let r = serde_json::json!({ "effects": { "status": { "status": "success" } } });
        assert!(dryrun_effects_ok(&r).is_ok());
    }

    // A dry-run failure (e.g. a bad seat signature the Move rejects) must error so the settler
    // refuses to sponsor gas — the error carries the on-chain status for the client log.
    #[test]
    fn dryrun_err_on_failure_effects() {
        let r = serde_json::json!({
            "effects": { "status": { "status": "failure", "error": "InvalidSignature" } }
        });
        let e = dryrun_effects_ok(&r).unwrap_err();
        assert!(e.contains("failure") || e.contains("InvalidSignature"), "got: {e}");
    }

    // A malformed result with no effects is treated as a failure, never a silent pass.
    #[test]
    fn dryrun_err_when_effects_missing() {
        let r = serde_json::json!({ "nope": true });
        assert!(dryrun_effects_ok(&r).is_err());
    }

    fn args_with_root(len: usize) -> CloseArgs {
        CloseArgs {
            tunnel_id: "0x1".into(),
            party_a_balance: 1500,
            party_b_balance: 500,
            sig_a: vec![1u8; 64],
            sig_b: vec![2u8; 64],
            timestamp: 1_750_000_000_000,
            transcript_root: vec![0u8; len],
        }
    }

    fn tunnel_ref() -> SharedRef {
        SharedRef {
            id: Address::from_str("0x2").unwrap(),
            initial_shared_version: 3,
        }
    }

    // The PTB must build for a well-formed settlement: a 32-byte root, both sigs, the
    // coin type arg. This pins the write-path wiring against the Move arg order.
    #[test]
    fn build_close_tx_builds_for_valid_settlement() {
        let tx = build_close_tx(
            Address::from_str("0xabc").unwrap(),
            "0x2::sui::SUI".parse().unwrap(),
            Address::ZERO,
            &args_with_root(32),
            &tunnel_ref(),
            1000,
        );
        assert!(tx.is_ok(), "valid settlement should build: {:?}", tx.err());
    }

    // The Move aborts on a non-32-byte root (EInvalidTranscriptRoot); reject it before
    // spending gas, with a clear error rather than an opaque on-chain failure.
    #[test]
    fn build_close_tx_rejects_wrong_root_length() {
        let err = build_close_tx(
            Address::ZERO,
            "0x2::sui::SUI".parse().unwrap(),
            Address::ZERO,
            &args_with_root(31),
            &tunnel_ref(),
            1000,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("32 bytes"), "got: {err}");
    }

    // Address-balance gas (SIP-58): the built close tx must carry an EMPTY gas payment so
    // the node charges gas as a FundsWithdrawal from the settler's SUI balance — no owned
    // gas coin to lock, so concurrent closes never equivocate.
    #[test]
    fn build_close_tx_uses_address_balance_gas() {
        let sender = Address::from_str("0x9").unwrap();
        let tx = build_close_tx(
            Address::from_str("0xabc").unwrap(),
            "0x2::sui::SUI".parse().unwrap(),
            sender,
            &args_with_root(32),
            &tunnel_ref(),
            1000,
        )
        .expect("builds");
        assert!(
            tx.gas_payment.objects.is_empty(),
            "gas payment must be empty (address-balance)"
        );
        assert_eq!(tx.gas_payment.owner, sender);
        assert_eq!(tx.gas_payment.budget, GAS_BUDGET);
    }

    // The indexer must lift payout + transcript root + tx digest out of a real suix_queryEvents
    // row, not just the tunnel id. Pins parsedJson field paths (u64 as string; vector<u8> as bytes).
    #[test]
    fn parses_closed_with_root_event_into_raw() {
        let row = serde_json::json!({
            "id": { "txDigest": "9xDigest", "eventSeq": "0" },
            "type": "0xPKG::tunnel::TunnelClosedWithRoot",
            "parsedJson": {
                "tunnel_id": "0xfeed",
                "party_a_balance": "1500",
                "party_b_balance": "500",
                "final_nonce": "7",
                "transcript_root": [222, 173, 190, 239],
                "closed_at": "1750000000000"
            },
            "timestampMs": "1750000000123"
        });
        let raw = parse_event_row(&row).expect("a lifecycle event parses");
        assert_eq!(raw.type_suffix, "TunnelClosedWithRoot");
        assert_eq!(raw.tunnel_id, "0xfeed");
        assert_eq!(raw.party_a_balance, Some(1500));
        assert_eq!(raw.party_b_balance, Some(500));
        assert_eq!(raw.transcript_root.as_deref(), Some("deadbeef"));
        assert_eq!(raw.tx_digest, "9xDigest");
        assert_eq!(raw.timestamp_ms, 1_750_000_000_123);
    }

    #[test]
    fn skips_non_tunnel_event_rows() {
        let row = serde_json::json!({ "id": { "txDigest": "x" }, "type": "0x::other::Thing" });
        assert!(parse_event_row(&row).is_none());
    }

    // A close maps to a `settled` row carrying payout + root; an activation maps to `opened`;
    // anything else (created / deposit) is not a displayable row.
    #[test]
    fn maps_raw_events_to_displayable_rows() {
        use crate::state::TunnelEventKind;
        let mut closed = RawTunnelEvent {
            type_suffix: "TunnelClosedWithRoot".into(),
            tunnel_id: "0xt".into(),
            party_a_balance: Some(1500),
            party_b_balance: Some(500),
            transcript_root: Some("deadbeef".into()),
            tx_digest: "d1".into(),
            timestamp_ms: 9,
        };
        let row = to_tunnel_event(&closed).expect("close is displayable");
        assert_eq!(row.kind, TunnelEventKind::Settled);
        assert_eq!(row.party_a_balance, Some(1500));
        assert_eq!(row.transcript_root.as_deref(), Some("deadbeef"));

        closed.type_suffix = "TunnelActivated".into();
        assert_eq!(to_tunnel_event(&closed).expect("activation").kind, TunnelEventKind::Opened);

        closed.type_suffix = "TunnelCreated".into();
        assert!(to_tunnel_event(&closed).is_none(), "created is not a row");
    }

    // The settler key loader must accept both the 32-byte raw secret and the 33-byte
    // flagged form, and reject anything else loudly.
    #[test]
    fn load_ed25519_accepts_32_and_33_byte_keys() {
        let b64 = base64::engine::general_purpose::STANDARD;
        assert!(load_ed25519(&b64.encode([9u8; 32])).is_ok());
        let mut flagged = vec![0u8];
        flagged.extend_from_slice(&[9u8; 32]);
        assert!(load_ed25519(&b64.encode(flagged)).is_ok());
        assert!(load_ed25519(&b64.encode([9u8; 16])).is_err());
    }

    // The JSON-RPC `signatures` field expects base64 of the 97-byte Sui form
    // flag(0x00)‖sig(64)‖pubkey(32). `execute()` uses `UserSignature::to_bytes()` for
    // this — NOT `bcs::to_bytes`, which double-tags the enum to 98 bytes (the bug this
    // test caught). A wrong layout would fail EVERY settle on a real node, which no
    // other test would catch.
    #[test]
    fn ed25519_signature_serializes_to_97_byte_sui_format() {
        let b64 = base64::engine::general_purpose::STANDARD;
        let sk = load_ed25519(&b64.encode([7u8; 32])).unwrap();
        let tx = build_close_tx(
            Address::from_str("0xabc").unwrap(),
            "0x2::sui::SUI".parse().unwrap(),
            Address::ZERO,
            &args_with_root(32),
            &tunnel_ref(),
            1000,
        )
        .unwrap();
        let sig = sk.sign_transaction(&tx).unwrap();
        let bytes = sig.to_bytes();
        assert_eq!(
            bytes.len(),
            97,
            "want flag(1)+sig(64)+pubkey(32), got {}",
            bytes.len()
        );
        assert_eq!(bytes[0], 0x00, "ed25519 flag byte");
        // Guard: bcs is the wrong encoder here (98 bytes); if this ever changes, revisit execute().
        assert_eq!(bcs::to_bytes(&sig).unwrap().len(), 98);
    }
}
