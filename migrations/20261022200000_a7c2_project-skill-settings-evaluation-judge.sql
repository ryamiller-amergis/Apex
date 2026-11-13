-- Up Migration
-- Optional model and effort for the workflow-evaluation LLM judge. NULL means
-- the judge uses the PRD Validation model and effort, as before.
ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS evaluation_judge_model TEXT,
  ADD COLUMN IF NOT EXISTS evaluation_judge_effort TEXT;

-- Down Migration
ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS evaluation_judge_model,
  DROP COLUMN IF EXISTS evaluation_judge_effort;
