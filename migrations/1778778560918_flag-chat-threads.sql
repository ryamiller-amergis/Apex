-- Up Migration: add flagged / flagged_at to chat_threads

ALTER TABLE chat_threads
  ADD COLUMN flagged    BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN flagged_at TIMESTAMPTZ;

CREATE INDEX idx_chat_threads_flagged
  ON chat_threads (user_id, flagged)
  WHERE flagged = TRUE;

-- Down Migration

ALTER TABLE chat_threads
  DROP COLUMN IF EXISTS flagged_at,
  DROP COLUMN IF EXISTS flagged;
