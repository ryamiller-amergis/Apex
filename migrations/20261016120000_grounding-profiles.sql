-- Up Migration

CREATE TABLE IF NOT EXISTS grounding_profiles (
  id_hash         TEXT PRIMARY KEY,
  run_ref         TEXT NOT NULL,
  provider        TEXT NOT NULL,
  project         TEXT NOT NULL,
  repo            TEXT NOT NULL,
  sha             TEXT NOT NULL,
  checkout_path   TEXT NOT NULL,
  mirror_path     TEXT,
  caller          TEXT,
  owner_user_id   TEXT NOT NULL,
  owner_run_ref   TEXT NOT NULL,
  owner_project   TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grounding_profiles_expires_at
  ON grounding_profiles (expires_at);

-- Down Migration

DROP TABLE IF EXISTS grounding_profiles;
