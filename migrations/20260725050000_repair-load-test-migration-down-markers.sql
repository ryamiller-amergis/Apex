-- Up Migration: repair columns dropped by mis-labeled DOWN sections
-- Earlier load-test migrations used `---- DOWN ----` instead of `-- Down Migration`,
-- so node-pg-migrate executed DROP statements as part of UP. Re-apply the intended
-- end state idempotently for DBs that already recorded those migrations.

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS load_test_generation_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS load_test_generation_model TEXT;

ALTER TABLE load_test_target
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_load_test_target_project_base_url
  ON load_test_target (project_id, base_url);

-- Intended FEAT-010 cleanup end state (requirement linkage removed from schema).
ALTER TABLE load_test
  DROP COLUMN IF EXISTS requirement_ref;

ALTER TABLE load_test_run
  DROP COLUMN IF EXISTS requirement_activity_posted_at,
  DROP COLUMN IF EXISTS requirement_activity_external_id;

-- Down Migration

DROP INDEX IF EXISTS uq_load_test_target_project_base_url;

ALTER TABLE load_test_target
  DROP COLUMN IF EXISTS is_active;

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS load_test_generation_model,
  DROP COLUMN IF EXISTS load_test_generation_skill_path;
