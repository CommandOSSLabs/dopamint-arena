-- TPS time-series for /v1/stats/history. tunnel-manager publishes the snapshot on Redis
-- `stats:snapshot`; the explorer indexer upserts one row per second here (PK ts_bucket → idempotent
-- across the N publishing instances). Rates are derived on read. Bounded by a retention delete; an
-- index over display-only data (the durable record is on-chain + the live counters in Valkey).
CREATE TABLE IF NOT EXISTS metric_bucket (
    ts_bucket        BIGINT PRIMARY KEY,   -- epoch seconds
    total_actions    BIGINT NOT NULL,
    active_tunnels   BIGINT NOT NULL,
    settled_tunnels  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS metric_bucket_ts_idx ON metric_bucket (ts_bucket DESC);
