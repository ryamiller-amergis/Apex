-- Up Migration: FEAT-011 TBI-011 — per-project k6 load-test AI generation skill settings

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS load_test_generation_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS load_test_generation_model TEXT;

---- DOWN ----

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS load_test_generation_model,
  DROP COLUMN IF EXISTS load_test_generation_skill_path;
