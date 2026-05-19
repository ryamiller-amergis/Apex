ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS interview_model TEXT,
  ADD COLUMN IF NOT EXISTS prd_model TEXT,
  ADD COLUMN IF NOT EXISTS design_doc_model TEXT;

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS default_model;
