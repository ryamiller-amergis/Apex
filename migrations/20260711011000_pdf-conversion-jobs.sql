-- Up Migration

CREATE TABLE pdf_conversion_jobs (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID        NOT NULL REFERENCES pdf_sessions(id) ON DELETE CASCADE,
  original_name      TEXT        NOT NULL,
  original_mime_type TEXT        NOT NULL,
  input_path         TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'queued'
                                 CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  file_id            UUID,
  error_code         TEXT,
  error_message      TEXT,
  owner_instance     TEXT,
  heartbeat_at       TIMESTAMPTZ,
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pdf_conversion_jobs_session_created
  ON pdf_conversion_jobs (session_id, created_at);

CREATE INDEX idx_pdf_conversion_jobs_status_created
  ON pdf_conversion_jobs (status, created_at);
