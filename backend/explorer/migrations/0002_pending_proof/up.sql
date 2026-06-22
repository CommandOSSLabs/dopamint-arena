-- Order-independent Walrus proof enrichment. The control plane PUBLISHes a proof to
-- `explorer:proofs` right after the Walrus upload — which usually arrives BEFORE the framework
-- indexer has ingested the close-tx checkpoint and written the settlement row. This table holds a
-- proof until its row exists. Both the `explorer:proofs` subscriber and the indexer commit write
-- their own contribution durably, then run the same idempotent drain (UPDATE settlement FROM
-- pending_proof; DELETE only the rows actually merged), so whichever becomes durable last completes
-- the enrichment. Rows here are transient — deleted as soon as their settlement row is enriched.
CREATE TABLE IF NOT EXISTS pending_proof (
    tx_digest      TEXT PRIMARY KEY,
    proof_url      TEXT,
    walrus_blob_id TEXT
);
