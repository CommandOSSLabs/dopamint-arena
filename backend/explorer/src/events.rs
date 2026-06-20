//! BCS shapes of the tunnel lifecycle events (mirror tunnel.move:281-329) + a pure mapping
//! to a Diesel-insertable settlement row. Pure => unit-tested; the framework wiring is in
//! bin/indexer.rs. Field order/types MUST match the Move structs exactly for BCS to decode.
//!
//! Move `ID`/`address` are 32-byte values serialized by BCS as 32 raw bytes (no length prefix).
//! Move `vector<u8>` serializes with a ULEB128 length prefix followed by bytes.
use serde::Deserialize;

// Sui `ID`/`address` are 32-byte values -> fixed arrays in BCS.
type SuiId = [u8; 32];

#[derive(Deserialize)]
pub struct TunnelCreated {
    pub tunnel_id: SuiId,
    pub party_a: SuiId, // address
    pub party_b: SuiId,
    pub created_at: u64,
}

#[derive(Deserialize)]
pub struct TunnelClosed {
    pub tunnel_id: SuiId,
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    pub final_nonce: u64,
    pub closed_at: u64,
}

#[derive(Deserialize)]
pub struct TunnelClosedWithRoot {
    pub tunnel_id: SuiId,
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    pub final_nonce: u64,
    pub transcript_root: Vec<u8>, // before closed_at — matches Move field order
    pub closed_at: u64,
}

fn hex0x(b: &[u8]) -> String {
    let mut s = String::from("0x");
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

fn hex(b: &[u8]) -> String {
    let mut s = String::new();
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

/// One row to insert. Mirrors the Diesel Insertable defined in handler.rs; kept plain here
/// so the mapping is testable without the framework/Diesel in scope.
///
/// `proof_url`, `walrus_blob_id`, and `game` are nullable schema columns NOT present here —
/// BCS lifecycle events don't carry them; handler.rs leaves them NULL on initial insert and
/// they are populated downstream (proof_url/walrus_blob_id via /settle enrichment; game later).
#[derive(Debug, PartialEq)]
pub struct RowData {
    pub tx_digest: String,
    pub kind: &'static str,
    pub tunnel_id: String,
    pub party_a_addr: Option<String>,
    pub party_b_addr: Option<String>,
    pub party_a_balance: Option<i64>,
    pub party_b_balance: Option<i64>,
    pub final_nonce: Option<i64>,
    pub transcript_root: Option<String>,
    pub checkpoint: i64,
    pub timestamp_ms: i64,
    pub closed_at_ms: Option<i64>,
}

/// Decode one event by its `type_` suffix + BCS `contents`, into a row at (digest, checkpoint).
/// Returns `None` for event types the indexer doesn't care about.
pub fn event_to_row(
    suffix: &str,
    contents: &[u8],
    tx_digest: &str,
    checkpoint: i64,
) -> Option<RowData> {
    match suffix {
        "TunnelCreated" => {
            let e: TunnelCreated = bcs::from_bytes(contents).ok()?;
            Some(RowData {
                tx_digest: tx_digest.into(),
                kind: "opened",
                tunnel_id: hex0x(&e.tunnel_id),
                party_a_addr: Some(hex0x(&e.party_a)),
                party_b_addr: Some(hex0x(&e.party_b)),
                party_a_balance: None,
                party_b_balance: None,
                final_nonce: None,
                transcript_root: None,
                checkpoint,
                timestamp_ms: e.created_at as i64,
                closed_at_ms: None,
            })
        }
        "TunnelClosed" => {
            let e: TunnelClosed = bcs::from_bytes(contents).ok()?;
            Some(RowData {
                tx_digest: tx_digest.into(),
                kind: "settled",
                tunnel_id: hex0x(&e.tunnel_id),
                party_a_addr: None,
                party_b_addr: None,
                // per-tunnel balances are far below i64::MAX (~9.2e18 MIST); only total supply approaches it
                party_a_balance: Some(e.party_a_balance as i64),
                party_b_balance: Some(e.party_b_balance as i64),
                final_nonce: Some(e.final_nonce as i64),
                transcript_root: None,
                checkpoint,
                timestamp_ms: e.closed_at as i64,
                closed_at_ms: Some(e.closed_at as i64),
            })
        }
        "TunnelClosedWithRoot" => {
            let e: TunnelClosedWithRoot = bcs::from_bytes(contents).ok()?;
            Some(RowData {
                tx_digest: tx_digest.into(),
                kind: "settled",
                tunnel_id: hex0x(&e.tunnel_id),
                party_a_addr: None,
                party_b_addr: None,
                party_a_balance: Some(e.party_a_balance as i64),
                party_b_balance: Some(e.party_b_balance as i64),
                final_nonce: Some(e.final_nonce as i64),
                transcript_root: Some(hex(&e.transcript_root)),
                checkpoint,
                timestamp_ms: e.closed_at as i64,
                closed_at_ms: Some(e.closed_at as i64),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // BCS is positional — field order in this tuple must match TunnelClosedWithRoot's Move
    // definition exactly: tunnel_id, party_a_balance, party_b_balance, final_nonce,
    // transcript_root, closed_at (tunnel.move:322-329).
    #[derive(serde::Serialize)]
    struct ClosedWithRootBcs([u8; 32], u64, u64, u64, Vec<u8>, u64);

    // tunnel_id, party_a_balance, party_b_balance, final_nonce, closed_at (tunnel.move:311-318).
    #[derive(serde::Serialize)]
    struct ClosedBcs([u8; 32], u64, u64, u64, u64);

    // tunnel_id, party_a, party_b, created_at (tunnel.move:281-286).
    #[derive(serde::Serialize)]
    struct CreatedBcs([u8; 32], [u8; 32], [u8; 32], u64);

    #[test]
    fn decodes_closed_with_root_via_bcs() {
        let tunnel_id = [1u8; 32];
        let transcript_root = vec![0xab, 0xcd];
        let encoded = bcs::to_bytes(&ClosedWithRootBcs(
            tunnel_id,
            60,
            40,
            3,
            transcript_root.clone(),
            1_750_000_000_000,
        ))
        .unwrap();

        let row = event_to_row("TunnelClosedWithRoot", &encoded, "DiG", 99).unwrap();
        assert_eq!(row.kind, "settled");
        assert_eq!(row.tunnel_id, hex0x(&tunnel_id));
        assert_eq!(row.party_a_balance, Some(60));
        assert_eq!(row.party_b_balance, Some(40));
        assert_eq!(row.final_nonce, Some(3));
        assert_eq!(row.transcript_root.as_deref(), Some("abcd"));
        assert_eq!(row.timestamp_ms, 1_750_000_000_000_i64);
        assert_eq!(row.closed_at_ms, Some(1_750_000_000_000_i64));
        assert_eq!(row.checkpoint, 99);
    }

    #[test]
    fn decodes_closed_into_settled_row() {
        let tunnel_id = [2u8; 32];
        let closed_at = 1_750_000_001_000_u64;
        let encoded =
            bcs::to_bytes(&ClosedBcs(tunnel_id, 100, 50, 7, closed_at)).unwrap();

        let row = event_to_row("TunnelClosed", &encoded, "DiG2", 42).unwrap();
        assert_eq!(row.kind, "settled");
        assert_eq!(row.party_a_balance, Some(100));
        assert_eq!(row.final_nonce, Some(7));
        assert!(row.transcript_root.is_none());
        assert_eq!(row.timestamp_ms, closed_at as i64);
        assert_eq!(row.closed_at_ms, Some(closed_at as i64));
        assert!(row.party_a_addr.is_none());
    }

    #[test]
    fn decodes_created_into_opened_row() {
        let tunnel_id = [3u8; 32];
        let party_a = [0xaau8; 32];
        let party_b = [0xbbu8; 32];
        let created_at = 1_750_000_002_000_u64;
        let encoded =
            bcs::to_bytes(&CreatedBcs(tunnel_id, party_a, party_b, created_at)).unwrap();

        let row = event_to_row("TunnelCreated", &encoded, "DiG3", 55).unwrap();
        assert_eq!(row.kind, "opened");
        assert_eq!(
            row.party_a_addr,
            Some(format!("0x{}", "aa".repeat(32)))
        );
        assert_eq!(
            row.party_b_addr,
            Some(format!("0x{}", "bb".repeat(32)))
        );
        assert!(row.party_a_balance.is_none());
        assert!(row.party_b_balance.is_none());
        assert!(row.final_nonce.is_none());
        assert!(row.transcript_root.is_none());
        assert_eq!(row.timestamp_ms, created_at as i64);
        assert!(row.closed_at_ms.is_none());
    }
}
