-- Up Migration
-- Register the My Work cloud agent flag with the kill switch off and no
-- targeting rules. A project sees the feature only after it is opted in.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'my-work-cloud-agent',
  'Gates Start Cloud Development on Azure DevOps My Work rows. Off keeps local Start Development / Resume / Close only.',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration
-- 20260901160000_cloud-agent-run-foundations.sql inserts the same flag and
-- deletes it when that migration rolls back. Leave the row in place here.
DO $$ BEGIN
  NULL;
END $$;
