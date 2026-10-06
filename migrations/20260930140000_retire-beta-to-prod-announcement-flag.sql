-- Up Migration: Retire the beta-to-prod-announcement feature flag.
-- The "Welcome to Apex Production" modal has been removed from the client.

DELETE FROM feature_flag_rules
WHERE flag_id = (SELECT id FROM feature_flags WHERE key = 'beta-to-prod-announcement');

DELETE FROM feature_flags WHERE key = 'beta-to-prod-announcement';

-- Down Migration

INSERT INTO feature_flags (key, description, enabled, lifecycle, cleanup_ready, created_by)
VALUES (
  'beta-to-prod-announcement',
  'Shows a one-time modal announcing the transition from beta to production',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;
