-- Up Migration: FEAT-007 — execution snapshot + target key for run lifecycle

ALTER TABLE load_test_run
  ADD COLUMN IF NOT EXISTS target_key TEXT,
  ADD COLUMN IF NOT EXISTS execution_snapshot JSONB;

-- At most one dispatched/running execution per project+target (queued waiters allowed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_load_test_run_active_target
  ON load_test_run (project_id, target_key)
  WHERE status IN ('dispatched', 'running') AND target_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_load_test_run_target_key
  ON load_test_run (project_id, target_key)
  WHERE target_key IS NOT NULL;
