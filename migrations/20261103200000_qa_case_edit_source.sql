-- Up

ALTER TABLE qa_case_regenerations
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'comments';

ALTER TABLE qa_case_regenerations
  DROP CONSTRAINT IF EXISTS qa_case_regenerations_source_check;

ALTER TABLE qa_case_regenerations
  ADD CONSTRAINT qa_case_regenerations_source_check
    CHECK (source IN ('comments', 'assistant'));

COMMENT ON COLUMN qa_case_regenerations.source IS
  'comments: an agent run rewrote the case from reviewer comments. assistant: Ask Apex edited the case in QA Lab chat.';

-- Down
-- ALTER TABLE qa_case_regenerations DROP CONSTRAINT IF EXISTS qa_case_regenerations_source_check;
-- ALTER TABLE qa_case_regenerations DROP COLUMN IF EXISTS source;
