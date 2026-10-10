ALTER TABLE feature_requests
  ADD COLUMN assigned_to_oid TEXT
    REFERENCES app_users(oid) ON DELETE SET NULL,
  ADD COLUMN assigned_to_apex BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE feature_requests
  ADD CONSTRAINT feature_requests_exclusive_assignee_check
  CHECK (
    (assigned_to_oid IS NOT NULL)::integer
      + (assigned_to_apex = TRUE)::integer
    <= 1
  );

CREATE INDEX idx_feature_requests_assigned_to_oid
  ON feature_requests (assigned_to_oid)
  WHERE assigned_to_oid IS NOT NULL;

-- DOWN
-- DROP INDEX IF EXISTS idx_feature_requests_assigned_to_oid;
-- ALTER TABLE feature_requests
--   DROP CONSTRAINT IF EXISTS feature_requests_exclusive_assignee_check,
--   DROP COLUMN IF EXISTS assigned_to_apex,
--   DROP COLUMN IF EXISTS assigned_to_oid;
