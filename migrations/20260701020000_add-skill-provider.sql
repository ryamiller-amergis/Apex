-- Up Migration
-- Add skill_provider column to project_skill_settings (default 'ado' for backward compat).

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS skill_provider VARCHAR(16) NOT NULL DEFAULT 'ado';

-- Down Migration

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS skill_provider;
