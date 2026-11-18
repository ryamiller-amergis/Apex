-- Up Migration
-- Move the workflow-evaluation judge model and effort off project_skill_settings
-- into project_skill_workflow_settings as the 'evaluation_judge' workflow.
-- 20261022200000_a7c2 added the columns before the workflow table existed; they
-- are present only on databases that ran it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'project_skill_settings' AND column_name = 'evaluation_judge_model'
  ) THEN
    INSERT INTO project_skill_workflow_settings (settings_id, workflow, model, effort, created_at, updated_at)
    SELECT id, 'evaluation_judge', evaluation_judge_model, evaluation_judge_effort, updated_at, updated_at
    FROM project_skill_settings
    WHERE num_nonnulls(evaluation_judge_model, evaluation_judge_effort) > 0
    ON CONFLICT (settings_id, workflow) DO UPDATE
    SET model = EXCLUDED.model, effort = EXCLUDED.effort, updated_at = EXCLUDED.updated_at;
  END IF;
END $$;

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS evaluation_judge_model,
  DROP COLUMN IF EXISTS evaluation_judge_effort;

-- Down Migration
ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS evaluation_judge_model TEXT,
  ADD COLUMN IF NOT EXISTS evaluation_judge_effort TEXT;

UPDATE project_skill_settings s
SET evaluation_judge_model = w.model, evaluation_judge_effort = w.effort
FROM project_skill_workflow_settings w
WHERE w.settings_id = s.id AND w.workflow = 'evaluation_judge';

DELETE FROM project_skill_workflow_settings WHERE workflow = 'evaluation_judge';
