-- Up Migration: api_keys table (FEAT-001 / TBI-001)
-- Project-scoped API key lifecycle persistence with soft-delete provenance.

CREATE TABLE api_keys (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  TEXT        NOT NULL,
  name        TEXT        NOT NULL
                          CHECK (char_length(name) >= 1 AND char_length(name) <= 100),
  key_hash    TEXT        NOT NULL,
  key_prefix  TEXT        NOT NULL
                          CHECK (char_length(key_prefix) = 8),
  cadence     TEXT        NOT NULL
                          CHECK (cadence IN ('30d', '60d', '90d', '180d', '1y', 'none')),
  expires_at  TIMESTAMPTZ,
  created_by  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  deleted_by  TEXT
);

-- Newest-first project-scoped list of non-deleted keys
CREATE INDEX idx_api_keys_project_created_active
  ON api_keys (project_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Case-insensitive uniqueness among non-deleted keys in a project (BR-002)
CREATE UNIQUE INDEX uq_api_keys_project_lower_name_active
  ON api_keys (project_id, lower(name))
  WHERE deleted_at IS NULL;

-- Fast indexed hash verification for FEAT-002 (< 100 ms P95)
CREATE UNIQUE INDEX uq_api_keys_key_hash
  ON api_keys (key_hash);

-- Down Migration
-- DROP TABLE IF EXISTS api_keys;
