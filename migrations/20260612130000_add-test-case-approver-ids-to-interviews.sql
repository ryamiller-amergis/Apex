-- Up Migration
ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS test_case_approver_ids JSONB;

-- Down Migration
ALTER TABLE interviews
  DROP COLUMN IF EXISTS test_case_approver_ids;
