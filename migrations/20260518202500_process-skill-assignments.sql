ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS interview_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS prd_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS design_doc_skill_path TEXT;
