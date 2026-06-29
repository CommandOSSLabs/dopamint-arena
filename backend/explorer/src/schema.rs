diesel::table! {
    settlement (tx_digest, tunnel_id) {
        tx_digest -> Text,
        kind -> Text,
        tunnel_id -> Text,
        party_a_addr -> Nullable<Text>,
        party_b_addr -> Nullable<Text>,
        party_a_balance -> Nullable<BigInt>,
        party_b_balance -> Nullable<BigInt>,
        final_nonce -> Nullable<BigInt>,
        transcript_root -> Nullable<Text>,
        proof_url -> Nullable<Text>,
        walrus_blob_id -> Nullable<Text>,
        checkpoint -> BigInt,
        timestamp_ms -> BigInt,
        closed_at_ms -> Nullable<BigInt>,
        game -> Nullable<Text>,
    }
}
