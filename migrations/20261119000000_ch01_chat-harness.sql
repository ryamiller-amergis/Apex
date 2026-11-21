-- Up Migration
-- Chat harness tables and additive thread columns:
-- - chat_thread_summaries: auto/user rolling summaries with latest non-fallback partial index
-- - chat_thread_commands: idempotent per-thread command log with steer count, payload purge,
--   and stale-accepted reconciliation indexes
-- - chat_threads.harness_area / harness_version: nullable opt-in metadata (no backfill)

CREATE TABLE IF NOT EXISTS chat_thread_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  source TEXT NOT NULL,
  is_fallback BOOLEAN NOT NULL DEFAULT false,
  covers_through_ordinal INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_thread_summaries_source_check CHECK (source IN ('auto', 'user'))
);

CREATE INDEX IF NOT EXISTS idx_chat_thread_summaries_latest_full
  ON chat_thread_summaries (thread_id, created_at DESC)
  WHERE is_fallback = false;

CREATE INDEX IF NOT EXISTS idx_chat_thread_summaries_thread_created
  ON chat_thread_summaries (thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_thread_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  command_id UUID NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_chat_thread_commands_thread_command UNIQUE (thread_id, command_id),
  CONSTRAINT chat_thread_commands_kind_check CHECK (kind IN ('send', 'steer', 'summarize', 'cancel', 'retry')),
  CONSTRAINT chat_thread_commands_status_check CHECK (status IN ('accepted', 'applied', 'rejected', 'queued'))
);

CREATE INDEX IF NOT EXISTS idx_chat_thread_commands_steer_count
  ON chat_thread_commands (thread_id, run_id, kind);

CREATE INDEX IF NOT EXISTS idx_chat_thread_commands_payload_purge
  ON chat_thread_commands (created_at)
  WHERE payload IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_thread_commands_stale_accepted
  ON chat_thread_commands (updated_at)
  WHERE status = 'accepted';

ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS harness_area TEXT;
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS harness_version INTEGER;

-- Down Migration

ALTER TABLE chat_threads DROP COLUMN IF EXISTS harness_version;
ALTER TABLE chat_threads DROP COLUMN IF EXISTS harness_area;
DROP TABLE IF EXISTS chat_thread_commands;
DROP TABLE IF EXISTS chat_thread_summaries;
