-- Add validation columns to design_docs
ALTER TABLE design_docs
  ADD COLUMN IF NOT EXISTS validation_thread_id UUID,
  ADD COLUMN IF NOT EXISTS validation_score INTEGER,
  ADD COLUMN IF NOT EXISTS validation_scorecard JSONB,
  ADD COLUMN IF NOT EXISTS validation_phase TEXT;

-- Add validation skill config to project_skill_settings
ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS design_doc_validation_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS design_doc_validation_model TEXT;
