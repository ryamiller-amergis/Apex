-- Up Migration
-- Add interview flow configuration columns to project_skill_settings.

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS interview_skill_options JSONB,
  ADD COLUMN IF NOT EXISTS prototype_stage_enabled BOOLEAN NOT NULL DEFAULT true;

-- Down Migration

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS interview_skill_options,
  DROP COLUMN IF EXISTS prototype_stage_enabled;
