-- Up Migration
-- Generalize the existing DOCX conversion queue for all heavy PDF jobs.

ALTER TABLE pdf_conversion_jobs
  RENAME COLUMN input_path TO input_key;

ALTER TABLE pdf_conversion_jobs
  ADD COLUMN job_type TEXT NOT NULL DEFAULT 'docx_convert'
    CHECK (job_type IN ('docx_convert', 'export')),
  ADD COLUMN user_id TEXT REFERENCES app_users(oid) ON DELETE CASCADE,
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  ADD COLUMN payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN result JSONB,
  ADD COLUMN lock_expires_at TIMESTAMPTZ;

UPDATE pdf_conversion_jobs AS jobs
SET user_id = sessions.user_id
FROM pdf_sessions AS sessions
WHERE sessions.id = jobs.session_id
  AND jobs.user_id IS NULL;

-- Give pre-migration in-flight jobs an immediately reaper-visible lease.
UPDATE pdf_conversion_jobs
SET lock_expires_at = COALESCE(heartbeat_at, updated_at, now())
WHERE status = 'processing'
  AND lock_expires_at IS NULL;

ALTER TABLE pdf_conversion_jobs
  ALTER COLUMN user_id SET NOT NULL;

CREATE INDEX idx_pdf_conversion_jobs_claim
  ON pdf_conversion_jobs (created_at)
  WHERE status = 'queued';

CREATE INDEX idx_pdf_conversion_jobs_processing_user
  ON pdf_conversion_jobs (user_id, lock_expires_at)
  WHERE status = 'processing';
