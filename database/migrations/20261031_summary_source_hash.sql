-- Additive idempotency key for call summaries. Existing rows keep a NULL hash
-- and remain readable; new summaries are unique per call and source snapshot.
ALTER TABLE call_summaries ADD COLUMN IF NOT EXISTS source_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_call_source_hash
  ON call_summaries(call_id, source_hash)
  WHERE source_hash IS NOT NULL;
