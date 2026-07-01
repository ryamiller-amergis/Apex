-- Add feature-request skill columns to project_skill_settings

ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS feature_request_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS feature_request_model TEXT;
