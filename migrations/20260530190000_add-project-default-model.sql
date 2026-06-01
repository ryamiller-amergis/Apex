-- Up Migration
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS default_model TEXT;

-- Down Migration
ALTER TABLE project_skill_settings DROP COLUMN IF EXISTS default_model;
