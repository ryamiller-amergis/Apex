-- Up Migration

ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS active_run_id TEXT;

-- Down Migration

-- ALTER TABLE chat_threads DROP COLUMN IF EXISTS active_run_id;
