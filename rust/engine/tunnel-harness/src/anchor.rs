//! The TunnelAnchor seam: chain IO that brackets a match. `open` creates/resolves
//! the tunnel object (producing the `tunnel_id` the seat is built from); `settle`
//! submits the co-signed cooperative close. Decoupled from the transcript: settle
//! signs the v1 settlement (no transcript root). An anchor impl may consume a
//! recorder by injection, but this trait never references one.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use crate::{Balances, Seat, TunnelAnchorError};
use tunnel_core::crypto::{blake2b256, verify};
use tunnel_core::protocol_id::ProtocolId;
use tunnel_core::wire::{serialize_settlement, Settlement};

/// Brackets a match with chain IO. Both methods are async and `Send` so the driver
/// can await them in its loop and be spawned on a multi-thread runtime.
pub trait TunnelAnchor {
    /// Create or resolve the tunnel object. Must be idempotent on
    /// `(protocol, party_a, party_b)`: the first caller creates, the second
    /// resolves the same `tunnel_id`.
    fn open(
        &self,
        request: TunnelOpenRequest,
    ) -> impl Future<Output = Result<OpenedTunnel, TunnelAnchorError>> + Send;

    /// Submit our co-signing half of the cooperative close. The anchor gathers both
    /// halves, verifies each over the canonical settlement bytes, and submits once.
    fn settle(
        &self,
        request: TunnelSettleRequest,
    ) -> impl Future<Output = Result<SettledTunnel, TunnelAnchorError>> + Send;
}

/// Open inputs. `(protocol, party_a, party_b)` is the idempotency key.
pub struct TunnelOpenRequest {
    pub protocol: ProtocolId,
    /// Ed25519 pubkeys, positional by seat (A then B).
    pub party_a: [u8; 32],
    pub party_b: [u8; 32],
    pub initial: Balances,
}

pub struct OpenedTunnel {
    pub tunnel_id: String,
    /// `true` if this call created the tunnel; `false` if it resolved an existing one.
    pub created: bool,
}

/// One co-signing half of a v1 cooperative close. Both halves must carry identical
/// `{party_a_balance, party_b_balance, final_nonce, timestamp}`.
pub struct TunnelSettleRequest {
    /// Which signature slot this call fills.
    pub by: Seat,
    pub tunnel_id: String,
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    pub final_nonce: u64,
    pub timestamp: u64,
    /// Our half over `serialize_settlement` (v1).
    pub signature: [u8; 64],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettledTunnel {
    pub digest: String,
    pub final_balances: Balances,
}

/// In-memory anchor for tests and self-play. `open` is idempotent on
/// `(protocol, party_a, party_b)`; `settle` parks the first caller on a oneshot
/// until the second arrives, pairs and verifies both halves over identical
/// canonical bytes, "submits" once, and returns the same `SettledTunnel` to both.
#[derive(Clone)]
pub struct InMemoryAnchor {
    inner: Arc<Mutex<AnchorInner>>,
}

struct AnchorInner {
    fixed_id: Option<String>,
    next_id: u64,
    opens: HashMap<(String, [u8; 32], [u8; 32]), OpenRecord>,
    settles: HashMap<String, SettleSlot>,
}

struct OpenRecord {
    tunnel_id: String,
    party_a: [u8; 32],
    party_b: [u8; 32],
}

enum SettleSlot {
    Waiting {
        first: TunnelSettleRequest,
        waker: oneshot::Sender<Result<SettledTunnel, TunnelAnchorError>>,
    },
    Settled(Result<SettledTunnel, TunnelAnchorError>),
}

impl InMemoryAnchor {
    pub fn new() -> Self {
        Self::build(None)
    }

    /// Always hand back `id` for this anchor's single tunnel. This lets self-play
    /// tests pin the on-chain id their signed bytes are built against.
    pub fn with_fixed_id(id: impl Into<String>) -> Self {
        Self::build(Some(id.into()))
    }

    fn build(fixed_id: Option<String>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(AnchorInner {
                fixed_id,
                next_id: 0,
                opens: HashMap::new(),
                settles: HashMap::new(),
            })),
        }
    }
}

impl Default for InMemoryAnchor {
    fn default() -> Self {
        Self::new()
    }
}

/// Pure pairing and verification of two settlement halves over identical canonical bytes.
fn pair_and_verify(
    first: &TunnelSettleRequest,
    second: &TunnelSettleRequest,
    pk_a: [u8; 32],
    pk_b: [u8; 32],
) -> Result<SettledTunnel, TunnelAnchorError> {
    if first.by == second.by {
        return Err(TunnelAnchorError::Mismatch(
            "both halves from same seat".into(),
        ));
    }
    if first.party_a_balance != second.party_a_balance
        || first.party_b_balance != second.party_b_balance
        || first.final_nonce != second.final_nonce
        || first.timestamp != second.timestamp
    {
        return Err(TunnelAnchorError::Mismatch(
            "settlement halves disagree".into(),
        ));
    }
    let bytes = serialize_settlement(&Settlement {
        tunnel_id: first.tunnel_id.clone(),
        party_a_balance: first.party_a_balance,
        party_b_balance: first.party_b_balance,
        final_nonce: first.final_nonce,
        timestamp: first.timestamp,
    });
    let verify_half = |r: &TunnelSettleRequest| {
        let pk = match r.by {
            Seat::A => pk_a,
            Seat::B => pk_b,
        };
        verify(&pk, &bytes, &r.signature)
    };
    if !verify_half(first) || !verify_half(second) {
        return Err(TunnelAnchorError::Rejected(
            "settlement signature invalid".into(),
        ));
    }
    Ok(SettledTunnel {
        digest: format!("0x{}", hex::encode(blake2b256(&bytes))),
        final_balances: Balances {
            a: first.party_a_balance,
            b: first.party_b_balance,
        },
    })
}

impl TunnelAnchor for InMemoryAnchor {
    async fn open(&self, request: TunnelOpenRequest) -> Result<OpenedTunnel, TunnelAnchorError> {
        let key = (
            request.protocol.as_str().to_string(),
            request.party_a,
            request.party_b,
        );
        let mut guard = self.inner.lock().expect("anchor mutex");
        if let Some(rec) = guard.opens.get(&key) {
            return Ok(OpenedTunnel {
                tunnel_id: rec.tunnel_id.clone(),
                created: false,
            });
        }
        let tunnel_id = match &guard.fixed_id {
            Some(id) => id.clone(),
            None => {
                guard.next_id += 1;
                format!("0x{:x}", guard.next_id)
            }
        };
        guard.opens.insert(
            key,
            OpenRecord {
                tunnel_id: tunnel_id.clone(),
                party_a: request.party_a,
                party_b: request.party_b,
            },
        );
        Ok(OpenedTunnel {
            tunnel_id,
            created: true,
        })
    }

    async fn settle(
        &self,
        request: TunnelSettleRequest,
    ) -> Result<SettledTunnel, TunnelAnchorError> {
        // All map mutation happens under the std mutex; the only await is reached
        // after the guard is dropped, so the future stays `Send`.
        let parked = {
            let mut guard = self.inner.lock().expect("anchor mutex");
            let pks = guard
                .opens
                .values()
                .find(|r| r.tunnel_id == request.tunnel_id)
                .map(|r| (r.party_a, r.party_b));
            let (pk_a, pk_b) = match pks {
                Some(p) => p,
                None => {
                    return Err(TunnelAnchorError::Rejected("settle before open".into()));
                }
            };
            match guard.settles.remove(&request.tunnel_id) {
                Some(SettleSlot::Settled(done)) => {
                    guard
                        .settles
                        .insert(request.tunnel_id.clone(), SettleSlot::Settled(done));
                    return Err(TunnelAnchorError::AlreadySettled);
                }
                Some(SettleSlot::Waiting { first, waker }) => {
                    let result = pair_and_verify(&first, &request, pk_a, pk_b);
                    guard.settles.insert(
                        request.tunnel_id.clone(),
                        SettleSlot::Settled(result.clone()),
                    );
                    drop(guard);
                    let _ = waker.send(result.clone());
                    return result;
                }
                None => {
                    let (tx, rx) = oneshot::channel();
                    guard.settles.insert(
                        request.tunnel_id.clone(),
                        SettleSlot::Waiting {
                            first: request,
                            waker: tx,
                        },
                    );
                    rx
                }
            }
        };
        parked.await.unwrap_or(Err(TunnelAnchorError::Unavailable(
            "peer dropped before settle".into(),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Signer;
    use tunnel_core::crypto::keypair_from_secret;
    use tunnel_core::wire::{serialize_settlement, Settlement};

    fn keys(seed: u8) -> ([u8; 32], [u8; 32]) {
        let secret: [u8; 32] = std::array::from_fn(|i| i as u8 + seed);
        let kp = keypair_from_secret(&secret);
        (secret, kp.public_key())
    }

    fn sign_half(
        secret: &[u8; 32],
        tunnel_id: &str,
        a: u64,
        b: u64,
        nonce: u64,
        ts: u64,
    ) -> [u8; 64] {
        let bytes = serialize_settlement(&Settlement {
            tunnel_id: tunnel_id.into(),
            party_a_balance: a,
            party_b_balance: b,
            final_nonce: nonce,
            timestamp: ts,
        });
        crate::LocalSigner::from_secret(secret).sign(&bytes)
    }

    #[test]
    fn open_request_carries_the_idempotency_key_fields() {
        let req = TunnelOpenRequest {
            protocol: ProtocolId::parse("payments.v1").unwrap(),
            party_a: [1u8; 32],
            party_b: [2u8; 32],
            initial: Balances { a: 100, b: 100 },
        };
        assert_eq!(req.protocol.as_str(), "payments.v1");
        assert_eq!(req.initial.sum(), 200);
    }

    #[tokio::test]
    async fn open_is_idempotent_on_protocol_and_parties() {
        let (_sa, pk_a) = keys(1);
        let (_sb, pk_b) = keys(40);
        let anchor = InMemoryAnchor::with_fixed_id("0xab");
        let req = || TunnelOpenRequest {
            protocol: ProtocolId::parse("payments.v1").unwrap(),
            party_a: pk_a,
            party_b: pk_b,
            initial: Balances { a: 100, b: 100 },
        };
        let first = anchor.open(req()).await.unwrap();
        let second = anchor.open(req()).await.unwrap();
        assert!(first.created);
        assert!(!second.created);
        assert_eq!(first.tunnel_id, "0xab");
        assert_eq!(second.tunnel_id, "0xab");
    }

    #[tokio::test]
    async fn settle_pairs_two_valid_halves_once_then_reports_already_settled() {
        let (sa, pk_a) = keys(1);
        let (sb, pk_b) = keys(40);
        let anchor = InMemoryAnchor::with_fixed_id("0xab");
        anchor
            .open(TunnelOpenRequest {
                protocol: ProtocolId::parse("payments.v1").unwrap(),
                party_a: pk_a,
                party_b: pk_b,
                initial: Balances { a: 100, b: 100 },
            })
            .await
            .unwrap();

        let mk = |by, sig| TunnelSettleRequest {
            tunnel_id: "0xab".into(),
            by,
            party_a_balance: 120,
            party_b_balance: 80,
            final_nonce: 4,
            timestamp: 9,
            signature: sig,
        };
        let sig_a = sign_half(&sa, "0xab", 120, 80, 4, 9);
        let sig_b = sign_half(&sb, "0xab", 120, 80, 4, 9);

        let (ra, rb) = tokio::join!(
            anchor.settle(mk(Seat::A, sig_a)),
            anchor.settle(mk(Seat::B, sig_b)),
        );
        let a = ra.unwrap();
        let b = rb.unwrap();
        assert_eq!(a.final_balances, Balances { a: 120, b: 80 });
        assert_eq!(a.digest, b.digest);

        let resettle = anchor.settle(mk(Seat::A, sig_a)).await;
        assert_eq!(resettle, Err(TunnelAnchorError::AlreadySettled));
    }

    #[tokio::test]
    async fn settle_rejects_disagreeing_halves() {
        let (sa, pk_a) = keys(1);
        let (sb, pk_b) = keys(40);
        let anchor = InMemoryAnchor::with_fixed_id("0xab");
        anchor
            .open(TunnelOpenRequest {
                protocol: ProtocolId::parse("payments.v1").unwrap(),
                party_a: pk_a,
                party_b: pk_b,
                initial: Balances { a: 100, b: 100 },
            })
            .await
            .unwrap();
        let half_a = TunnelSettleRequest {
            tunnel_id: "0xab".into(),
            by: Seat::A,
            party_a_balance: 120,
            party_b_balance: 80,
            final_nonce: 4,
            timestamp: 9,
            signature: sign_half(&sa, "0xab", 120, 80, 4, 9),
        };
        let half_b = TunnelSettleRequest {
            tunnel_id: "0xab".into(),
            by: Seat::B,
            party_a_balance: 110, // disagrees
            party_b_balance: 90,
            final_nonce: 4,
            timestamp: 9,
            signature: sign_half(&sb, "0xab", 110, 90, 4, 9),
        };
        let (ra, rb) = tokio::join!(anchor.settle(half_a), anchor.settle(half_b));
        assert!(matches!(ra, Err(TunnelAnchorError::Mismatch(_))));
        assert!(matches!(rb, Err(TunnelAnchorError::Mismatch(_))));
    }
}
