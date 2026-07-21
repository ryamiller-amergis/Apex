-- Add type-specific Apex Backlog analysis settings.

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS technical_skill_path TEXT;

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS technical_model TEXT;

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS issue_skill_path TEXT;

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS issue_model TEXT;
