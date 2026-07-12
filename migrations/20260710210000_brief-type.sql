-- Add brief_type to ai_cost_daily_brief to distinguish morning vs afternoon briefs
ALTER TABLE ai_cost_daily_brief
  ADD COLUMN IF NOT EXISTS brief_type TEXT NOT NULL DEFAULT 'morning' CHECK (brief_type IN ('morning', 'afternoon'));

-- Drop the old unique constraint (was on project + brief_date only)
ALTER TABLE ai_cost_daily_brief
  DROP CONSTRAINT IF EXISTS ai_cost_daily_brief_project_date;

-- New unique constraint includes brief_type
ALTER TABLE ai_cost_daily_brief
  ADD CONSTRAINT ai_cost_daily_brief_project_date_type UNIQUE (project, brief_date, brief_type);
