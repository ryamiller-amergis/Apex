-- Up Migration
CREATE TABLE IF NOT EXISTS eslint_burn_down_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_build_id INTEGER NOT NULL,
  build_number TEXT NOT NULL,
  definition_name TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  total_files INTEGER NOT NULL DEFAULT 0,
  files_with_problems INTEGER NOT NULL DEFAULT 0,
  total_errors INTEGER NOT NULL DEFAULT 0,
  total_warnings INTEGER NOT NULL DEFAULT 0,
  issue_count INTEGER NOT NULL DEFAULT 0,
  fixable_count INTEGER NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pipeline_build_id)
);

CREATE INDEX idx_eslint_burn_down_snapshots_captured_at
  ON eslint_burn_down_snapshots (captured_at ASC);

-- Down Migration
-- DROP TABLE IF EXISTS eslint_burn_down_snapshots;
