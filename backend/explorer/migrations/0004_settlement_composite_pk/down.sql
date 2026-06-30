-- Reverting once multi-tunnel-per-tx rows exist will fail (duplicate tx_digest) — expected; the
-- forward composite key is what production runs.
ALTER TABLE settlement DROP CONSTRAINT settlement_pkey;
ALTER TABLE settlement ADD PRIMARY KEY (tx_digest);
