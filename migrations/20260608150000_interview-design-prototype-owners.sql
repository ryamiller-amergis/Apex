-- Up Migration

ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS design_prototype_owner_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS design_prototype_approver_ids JSONB;

ALTER TABLE prds
  ADD COLUMN IF NOT EXISTS design_prototype_approver_ids JSONB;

-- Down Migration

ALTER TABLE prds
  DROP COLUMN IF EXISTS design_prototype_approver_ids;

ALTER TABLE interviews
  DROP COLUMN IF EXISTS design_prototype_approver_ids,
  DROP COLUMN IF EXISTS design_prototype_owner_id;
