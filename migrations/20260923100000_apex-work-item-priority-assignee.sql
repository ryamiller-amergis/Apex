ALTER TABLE apex_work_items
  ALTER COLUMN owner_oid DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS assigned_to_apex BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS priority TEXT,
  ADD COLUMN IF NOT EXISTS priority_rank INTEGER,
  ADD COLUMN IF NOT EXISTS ai_priority_rationale TEXT,
  ADD COLUMN IF NOT EXISTS ai_ranked_at TIMESTAMPTZ;

ALTER TABLE apex_work_items
  ADD CONSTRAINT apex_work_items_exclusive_assignee_check
    CHECK ((owner_oid IS NOT NULL)::integer + (assigned_to_apex = TRUE)::integer = 1),
  ADD CONSTRAINT apex_work_items_priority_check
    CHECK (priority IS NULL OR priority IN ('critical', 'high', 'medium', 'low')),
  ADD CONSTRAINT apex_work_items_priority_rank_check
    CHECK (priority_rank IS NULL OR priority_rank > 0);

CREATE INDEX IF NOT EXISTS idx_apex_work_items_project_priority_rank
  ON apex_work_items (project, priority_rank)
  WHERE priority_rank IS NOT NULL;

-- DOWN
-- DROP INDEX IF EXISTS idx_apex_work_items_project_priority_rank;
-- ALTER TABLE apex_work_items DROP CONSTRAINT IF EXISTS apex_work_items_priority_rank_check;
-- ALTER TABLE apex_work_items DROP CONSTRAINT IF EXISTS apex_work_items_priority_check;
-- ALTER TABLE apex_work_items DROP CONSTRAINT IF EXISTS apex_work_items_exclusive_assignee_check;
-- ALTER TABLE apex_work_items DROP COLUMN IF EXISTS ai_ranked_at;
-- ALTER TABLE apex_work_items DROP COLUMN IF EXISTS ai_priority_rationale;
-- ALTER TABLE apex_work_items DROP COLUMN IF EXISTS priority_rank;
-- ALTER TABLE apex_work_items DROP COLUMN IF EXISTS priority;
-- ALTER TABLE apex_work_items DROP COLUMN IF EXISTS assigned_to_apex;
-- ALTER TABLE apex_work_items ALTER COLUMN owner_oid SET NOT NULL;
