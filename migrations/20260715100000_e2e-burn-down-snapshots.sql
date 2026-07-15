-- Up Migration

CREATE TABLE IF NOT EXISTS e2e_burn_down_snapshots (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_build_id INTEGER     NOT NULL,
  suite_key         TEXT        NOT NULL,
  build_number      TEXT        NOT NULL,
  definition_name   TEXT        NOT NULL,
  captured_at       TIMESTAMPTZ NOT NULL,
  total_tests       INTEGER     NOT NULL DEFAULT 0,
  passed            INTEGER     NOT NULL DEFAULT 0,
  failed            INTEGER     NOT NULL DEFAULT 0,
  flaky             INTEGER     NOT NULL DEFAULT 0,
  skipped           INTEGER     NOT NULL DEFAULT 0,
  pass_rate         NUMERIC(5,2) NOT NULL DEFAULT 0,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT e2e_burn_down_snapshots_build_suite_unique UNIQUE (pipeline_build_id, suite_key)
);

CREATE INDEX IF NOT EXISTS idx_e2e_burn_down_snapshots_captured_at
  ON e2e_burn_down_snapshots (captured_at);

CREATE INDEX IF NOT EXISTS idx_e2e_burn_down_snapshots_suite_captured_at
  ON e2e_burn_down_snapshots (suite_key, captured_at);

-- Down Migration

DROP TABLE IF EXISTS e2e_burn_down_snapshots;
