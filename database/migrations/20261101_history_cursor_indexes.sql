-- Add stable keyset pagination and all-status callback reminder indexes.
-- Rollback: DROP INDEX IF EXISTS idx_calls_created_id; DROP INDEX IF EXISTS idx_calls_callback_all;
CREATE INDEX IF NOT EXISTS idx_calls_created_id ON calls(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_calls_callback_all ON calls(callback_at ASC, id ASC) WHERE callback_at IS NOT NULL;
