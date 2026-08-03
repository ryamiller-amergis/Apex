-- Up Migration: add nullable Cursor-agent grounding binding to chat_threads

ALTER TABLE chat_threads
  ADD COLUMN grounding_mode TEXT,
  ADD COLUMN grounded_sha   TEXT;

-- Down Migration

ALTER TABLE chat_threads
  DROP COLUMN IF EXISTS grounded_sha,
  DROP COLUMN IF EXISTS grounding_mode;
