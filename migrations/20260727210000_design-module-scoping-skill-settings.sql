-- Up Migration: Design Module scoping skill + model (project settings sidecar)

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS design_module_scoping_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS design_module_scoping_model TEXT;

-- Down Migration

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS design_module_scoping_model,
  DROP COLUMN IF EXISTS design_module_scoping_skill_path;
