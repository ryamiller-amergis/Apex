-- Up Migration

ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS discovery_assignee_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivery_assignee_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS technical_assignee_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL;

-- Down Migration

ALTER TABLE interviews
  DROP COLUMN IF EXISTS technical_assignee_id,
  DROP COLUMN IF EXISTS delivery_assignee_id,
  DROP COLUMN IF EXISTS discovery_assignee_id;
