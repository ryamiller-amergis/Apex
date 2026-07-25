-- Up Migration: FEAT-005 — add is_active + unique (project_id, base_url) on load_test_target
-- FEAT-001 created the table without soft-disable / uniqueness; tech-spec allows amending incomplete columns.

ALTER TABLE load_test_target
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_load_test_target_project_base_url
  ON load_test_target (project_id, base_url);

---- DOWN ----

DROP INDEX IF EXISTS uq_load_test_target_project_base_url;

ALTER TABLE load_test_target
  DROP COLUMN IF EXISTS is_active;
