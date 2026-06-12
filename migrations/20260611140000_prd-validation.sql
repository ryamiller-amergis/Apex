-- Add PRD validation columns to prds table
ALTER TABLE prds
  ADD COLUMN IF NOT EXISTS validation_thread_id UUID,
  ADD COLUMN IF NOT EXISTS validation_score INTEGER,
  ADD COLUMN IF NOT EXISTS validation_scorecard JSONB,
  ADD COLUMN IF NOT EXISTS validation_report_md TEXT,
  ADD COLUMN IF NOT EXISTS validation_phase TEXT,
  ADD COLUMN IF NOT EXISTS fix_baseline JSONB;

-- Add PRD validation skill/model columns to project_skill_settings
ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS prd_validation_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS prd_validation_model TEXT;
