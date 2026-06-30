-- A single transaction (one PTB) can open or settle MANY tunnels, each emitting its own lifecycle
-- event under ONE tx_digest. Keying settlement by tx_digest alone made the indexer's batched
-- `ON CONFLICT (tx_digest) DO UPDATE` fail with "ON CONFLICT DO UPDATE command cannot affect row a
-- second time" and freeze the pipeline watermark. The real row identity is (tx_digest, tunnel_id).
ALTER TABLE settlement DROP CONSTRAINT settlement_pkey;
ALTER TABLE settlement ADD PRIMARY KEY (tx_digest, tunnel_id);
