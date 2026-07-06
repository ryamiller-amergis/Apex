-- Up Migration

CREATE TABLE pdf_sessions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  project_id      TEXT,
  status          TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exported', 'expired')),
  page_manifest   JSONB       NOT NULL DEFAULT '[]',
  file_metadata   JSONB       NOT NULL DEFAULT '[]',
  export_filename TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '4 hours')
);

CREATE INDEX idx_pdf_sessions_user_id ON pdf_sessions (user_id);
CREATE INDEX idx_pdf_sessions_expires_at ON pdf_sessions (expires_at) WHERE status = 'active';
