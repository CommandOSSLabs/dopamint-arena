-- Explorer read-model: one row per indexed lifecycle tx, keyed by digest. Written by the
-- framework indexer (Diesel) and read by explorer-api (sqlx, the `shared` crate). An index
-- over data already durable on-chain + Walrus (roll-off later; not the source of truth).
CREATE TABLE IF NOT EXISTS settlement (
    tx_digest        TEXT PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('opened','settled')),
    tunnel_id        TEXT NOT NULL,
    party_a_addr     TEXT,
    party_b_addr     TEXT,
    party_a_balance  BIGINT,
    party_b_balance  BIGINT,
    final_nonce      BIGINT,
    transcript_root  TEXT,
    proof_url        TEXT,
    walrus_blob_id   TEXT,
    checkpoint       BIGINT NOT NULL,
    timestamp_ms     BIGINT NOT NULL,
    closed_at_ms     BIGINT,
    game             TEXT
);
CREATE INDEX IF NOT EXISTS settlement_ts_idx      ON settlement (timestamp_ms DESC, tx_digest DESC);
CREATE INDEX IF NOT EXISTS settlement_tunnel_idx  ON settlement (tunnel_id);
CREATE INDEX IF NOT EXISTS settlement_party_a_idx ON settlement (party_a_addr);
CREATE INDEX IF NOT EXISTS settlement_party_b_idx ON settlement (party_b_addr);

-- Write-time counter for the explorer header (read by explorer-api; NEVER COUNT(*) at read).
CREATE TABLE IF NOT EXISTS settlement_meta (
    key   TEXT PRIMARY KEY,
    value BIGINT NOT NULL
);
INSERT INTO settlement_meta (key, value) VALUES ('settled_count', 0)
    ON CONFLICT (key) DO NOTHING;

-- Maintain settled_count at write: AFTER INSERT fires once per genuinely-new settled row.
-- A later ON CONFLICT DO UPDATE (the /settle proof enrichment) hits AFTER UPDATE, not AFTER
-- INSERT, so the count is never double-incremented.
CREATE OR REPLACE FUNCTION bump_settled_count() RETURNS trigger AS $$
BEGIN
    UPDATE settlement_meta SET value = value + 1 WHERE key = 'settled_count';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS settlement_settled_count ON settlement;
CREATE TRIGGER settlement_settled_count
    AFTER INSERT ON settlement
    FOR EACH ROW WHEN (NEW.kind = 'settled')
    EXECUTE FUNCTION bump_settled_count();
