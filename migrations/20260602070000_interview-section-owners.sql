-- Up Migration
ALTER TABLE interviews
  ADD COLUMN prd_owner_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  ADD COLUMN design_doc_owner_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL;

-- Down Migration
ALTER TABLE interviews
  DROP COLUMN IF EXISTS prd_owner_id,
  DROP COLUMN IF EXISTS design_doc_owner_id;