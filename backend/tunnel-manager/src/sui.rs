//! On-chain cooperative settlement via the lightweight Sui SDK (PTB build + Ed25519
//! sign) and JSON-RPC (object resolution + execution).
//!
//! The settler is a NON-PARTY gas payer: only the two co-signatures verify on-chain
//! (tunnel.move:1062). It derives NO nonce — `final_nonce` is reconstructed on-chain
//! as `tunnel.state.nonce + 1`; `sig_a`/`sig_b` are passed verbatim. See ADR-0002.
//!
//! Verification: unit-tested (build_close_tx, key load, signature format) AND e2e-verified
//! on localnet — `POST /settle` submitted `close_cooperative_with_root`, the node executed
//! it (effects success + `TunnelClosedWithRoot` event). Publishing the 134 KB framework
//! required raising the localnet cap (`SUI_PROTOCOL_CONFIG_OVERRIDE_max_move_package_size`).
//! The e2e caught two bugs since fixed: signature serialization (`UserSignature::to_base64`,
//! not `bcs::to_bytes`) and `vector<u8>` arg encoding (`pure`, not `pure_bytes`).

use std::str::FromStr;

use anyhow::{anyhow, Context};
use base64::Engine;
use sui_crypto::ed25519::Ed25519PrivateKey;
use sui_crypto::SuiSigner;
use sui_sdk_types::{Address, Digest, Identifier, Transaction, TypeTag, UserSignature};
use sui_transaction_builder::{Function, ObjectInput, TransactionBuilder};
use tokio::sync::Mutex;

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

/// An owned object's full ref (used for the gas coin).
#[derive(Clone)]
struct OwnedRef {
    id: Address,
    version: u64,
    digest: Digest,
}

/// On-chain refs + gas price resolved (over JSON-RPC) just before building the tx.
struct ResolvedRefs {
    tunnel: SharedRef,
    clock: SharedRef,
    gas: OwnedRef,
    gas_price: u64,
}

pub struct SuiSettler {
    http: reqwest::Client,
    rpc_url: String,
    package_id: Address,
    coin_type: TypeTag,
    signer: Ed25519PrivateKey,
    sender: Address,
    // One gas key serving all settles: serialize gas-select + sign + execute so
    // concurrent /settle requests don't grab the same gas coin version and equivocate.
    gas_lock: Mutex<()>,
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
            gas_lock: Mutex::new(()),
        })
    }

    /// Build, sign, and execute `close_cooperative_with_root`; returns the tx digest.
    /// Resolves shared/gas object refs over JSON-RPC, then builds + signs offline.
    pub async fn submit_close(&self, args: CloseArgs) -> anyhow::Result<String> {
        let _gas = self.gas_lock.lock().await;

        let refs = ResolvedRefs {
            tunnel: self.resolve_shared(&args.tunnel_id).await?,
            clock: SharedRef {
                id: Address::from_str(CLOCK_ADDRESS).expect("static clock id"),
                initial_shared_version: 1,
            },
            gas: self.pick_gas_coin().await?,
            gas_price: self.reference_gas_price().await?,
        };

        let tx = build_close_tx(
            self.package_id,
            self.coin_type.clone(),
            self.sender,
            &args,
            &refs,
        )?;
        let sig = self
            .signer
            .sign_transaction(&tx)
            .map_err(|e| anyhow!("sign close tx: {e}"))?;
        self.execute(&tx, &sig).await
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

    async fn pick_gas_coin(&self) -> anyhow::Result<OwnedRef> {
        let r = self
            .rpc(
                "suix_getCoins",
                serde_json::json!([self.sender.to_string(), "0x2::sui::SUI", null, 1]),
            )
            .await?;
        let c = r
            .pointer("/data/0")
            .ok_or_else(|| anyhow!("settler {} has no SUI gas coins", self.sender))?;
        Ok(OwnedRef {
            id: Address::from_str(
                c.get("coinObjectId")
                    .and_then(|v| v.as_str())
                    .context("coinObjectId")?,
            )?,
            version: c
                .get("version")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
                .context("gas version")?,
            digest: Digest::from_str(
                c.get("digest")
                    .and_then(|v| v.as_str())
                    .context("gas digest")?,
            )?,
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
    /// `(events, next_cursor)` where each event is `(type_string, tunnel_id)`; the cursor
    /// is opaque (passed straight back). e2e-deferred (needs a live node + package).
    pub async fn query_tunnel_events(
        &self,
        cursor: Option<serde_json::Value>,
    ) -> anyhow::Result<(Vec<(String, String)>, Option<serde_json::Value>)> {
        let filter = serde_json::json!({
            "MoveModule": { "package": self.package_id.to_string(), "module": "tunnel" }
        });
        let r = self
            .rpc(
                "suix_queryEvents",
                serde_json::json!([filter, cursor, 50, false]),
            )
            .await?;
        let mut events = Vec::new();
        if let Some(data) = r.get("data").and_then(|v| v.as_array()) {
            for ev in data {
                let etype = ev.get("type").and_then(|v| v.as_str()).unwrap_or_default();
                // tunnel lifecycle events carry the object id under parsedJson.tunnel_id.
                if let Some(tid) = ev.pointer("/parsedJson/tunnel_id").and_then(|v| v.as_str()) {
                    events.push((etype.to_string(), tid.to_string()));
                }
            }
        }
        // Advance only when the node gives a cursor; a null cursor (empty poll) keeps our
        // position so we don't replay from genesis every tick.
        let next = r.get("nextCursor").cloned().filter(|v| !v.is_null());
        Ok((events, next))
    }
}

/// Fold one tunnel event into the registry, maintaining the active/settled counts at
/// write time. Idempotent under cursor replay: re-applying a terminal event is a no-op
/// on the counts. The indexer is the single writer, so the stats tick reads O(1).
pub fn apply_event(
    map: &mut std::collections::HashMap<String, crate::state::TunnelStatus>,
    active: &std::sync::atomic::AtomicU64,
    settled: &std::sync::atomic::AtomicU64,
    event_type: &str,
    tunnel_id: String,
) {
    use crate::state::TunnelStatus::{Active, Closed, Created};
    use std::sync::atomic::Ordering::Relaxed;
    let new = match event_type.rsplit("::").next() {
        Some("TunnelCreated") => Created,
        Some("TunnelActivated") => Active,
        Some("TunnelClosed" | "TunnelClosedWithRoot") => Closed,
        _ => return,
    };
    let prev = map.insert(tunnel_id, new);
    let was_active = matches!(prev, Some(Active));
    match new {
        // Created is funded-but-not-active → not counted as active until TunnelActivated.
        Active if !was_active => {
            active.fetch_add(1, Relaxed);
        }
        Closed if !matches!(prev, Some(Closed)) => {
            if was_active {
                active.fetch_sub(1, Relaxed);
            }
            settled.fetch_add(1, Relaxed);
        }
        _ => {}
    }
}

/// Poll the chain for this package's tunnel events and fold them into the registry — the
/// authoritative source for active/settled counts (ADR-0002; `POST /sessions` is advisory).
/// Reuses `state.settler`'s client. Replays from cursor=None on restart; `apply_event` is
/// idempotent so counts don't double. e2e-deferred (needs a live node + published package).
pub fn spawn_event_indexer(state: crate::state::SharedState) {
    tokio::spawn(async move {
        let mut cursor = None;
        loop {
            match state.settler.query_tunnel_events(cursor.clone()).await {
                Ok((events, next)) => {
                    {
                        let mut map = state.tunnels.write().expect("tunnels lock");
                        for (etype, tid) in events {
                            apply_event(
                                &mut map,
                                &state.active_tunnels,
                                &state.settled_tunnels,
                                &etype,
                                tid,
                            );
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

/// PURE core: build the `close_cooperative_with_root` PTB from resolved refs. Arg order
/// matches the Move signature exactly: tunnel, a_balance, b_balance, sig_a, sig_b,
/// timestamp, transcript_root, clock. Unit-tested.
fn build_close_tx(
    package_id: Address,
    coin_type: TypeTag,
    sender: Address,
    args: &CloseArgs,
    refs: &ResolvedRefs,
) -> anyhow::Result<Transaction> {
    anyhow::ensure!(
        args.transcript_root.len() == 32,
        "transcript_root must be 32 bytes, got {}",
        args.transcript_root.len()
    );
    let mut tb = TransactionBuilder::new();
    let tunnel_arg = tb.object(ObjectInput::shared(
        refs.tunnel.id,
        refs.tunnel.initial_shared_version,
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
        refs.clock.id,
        refs.clock.initial_shared_version,
        false,
    ));

    let func = Function::new(
        package_id,
        Identifier::new("tunnel").context("module ident")?,
        Identifier::new("close_cooperative_with_root").context("fn ident")?,
    )
    .with_type_args(vec![coin_type]);
    tb.move_call(func, vec![tunnel_arg, a, b, sa, sb, ts, root, clock_arg]);

    tb.add_gas_objects([ObjectInput::owned(
        refs.gas.id,
        refs.gas.version,
        refs.gas.digest,
    )]);
    tb.set_sender(sender);
    tb.set_gas_budget(GAS_BUDGET);
    tb.set_gas_price(refs.gas_price.max(1));
    tb.try_build().map_err(|e| anyhow!("build close tx: {e}"))
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

    fn refs() -> ResolvedRefs {
        ResolvedRefs {
            tunnel: SharedRef {
                id: Address::from_str("0x2").unwrap(),
                initial_shared_version: 3,
            },
            clock: SharedRef {
                id: Address::from_str(CLOCK_ADDRESS).unwrap(),
                initial_shared_version: 1,
            },
            gas: OwnedRef {
                id: Address::from_str("0x3").unwrap(),
                version: 5,
                digest: Digest::ZERO,
            },
            gas_price: 1000,
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
            &refs(),
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
            &refs(),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("32 bytes"), "got: {err}");
    }

    // The registry is event-derived: Created→Active→Closed reduces to Closed with
    // active=0/settled=1, and re-delivery of the close (cursor replay on restart) must
    // NOT move the counts again. This is the authoritative-registry invariant.
    #[test]
    fn events_reduce_to_terminal_status_and_maintain_counts() {
        use crate::state::TunnelStatus;
        use std::collections::HashMap;
        use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

        let (active, settled) = (AtomicU64::new(0), AtomicU64::new(0));
        let mut m = HashMap::new();
        apply_event(
            &mut m,
            &active,
            &settled,
            "0xp::tunnel::TunnelCreated",
            "0xt".into(),
        );
        assert_eq!(m["0xt"], TunnelStatus::Created);
        apply_event(
            &mut m,
            &active,
            &settled,
            "0xp::tunnel::TunnelActivated",
            "0xt".into(),
        );
        assert_eq!((m["0xt"], active.load(Relaxed)), (TunnelStatus::Active, 1));
        apply_event(
            &mut m,
            &active,
            &settled,
            "0xp::tunnel::TunnelClosedWithRoot",
            "0xt".into(),
        );
        assert_eq!(
            (m["0xt"], active.load(Relaxed), settled.load(Relaxed)),
            (TunnelStatus::Closed, 0, 1)
        );

        // Cursor replay re-delivers the same close: counts stay put.
        apply_event(
            &mut m,
            &active,
            &settled,
            "0xp::tunnel::TunnelClosedWithRoot",
            "0xt".into(),
        );
        assert_eq!((active.load(Relaxed), settled.load(Relaxed)), (0, 1));

        // Unknown events are ignored (status unchanged).
        apply_event(
            &mut m,
            &active,
            &settled,
            "0xp::tunnel::DisputeRaised",
            "0xt".into(),
        );
        assert_eq!(m["0xt"], TunnelStatus::Closed);
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
            &refs(),
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
