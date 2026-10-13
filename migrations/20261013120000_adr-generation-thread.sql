-- Up Migration
ALTER TABLE adrs
  ADD COLUMN IF NOT EXISTS generation_thread_id UUID REFERENCES chat_threads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_adrs_generation_thread_id
  ON adrs (generation_thread_id)
  WHERE generation_thread_id IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_adrs_generation_thread_id;

ALTER TABLE adrs
  DROP COLUMN IF EXISTS generation_thread_id;
