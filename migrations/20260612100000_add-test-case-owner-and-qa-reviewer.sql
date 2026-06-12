-- Up Migration
ALTER TABLE interviews
  ADD COLUMN test_case_owner_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL;

-- Down Migration
ALTER TABLE interviews
  DROP COLUMN IF EXISTS test_case_owner_id;
