-- Up Migration
-- Project-scoped integration connections. The credential is stored only as
-- AES-256-GCM ciphertext plus a masked hint.

CREATE TABLE integration_connections (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project                TEXT        NOT NULL,
  name                   TEXT        NOT NULL,
  provider               TEXT        NOT NULL,
  status                 TEXT        NOT NULL DEFAULT 'untested',
  credential_ciphertext  TEXT        NOT NULL,
  credential_iv          TEXT        NOT NULL,
  credential_auth_tag    TEXT        NOT NULL,
  credential_hint        TEXT        NOT NULL,
  base_url               TEXT,
  operations             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  allowed_user_ids       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_by             TEXT        NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_tested_at         TIMESTAMPTZ
);

CREATE INDEX idx_integration_connections_project
  ON integration_connections (project);

-- Down Migration

DROP TABLE IF EXISTS integration_connections;
