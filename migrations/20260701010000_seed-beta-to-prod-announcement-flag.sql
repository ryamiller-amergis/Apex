-- Up Migration: Insert the beta-to-prod-announcement feature flag (disabled by default).
-- Idempotent — safe to re-run if the flag already exists.

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

-- Add an "everyone" targeting rule so that once the kill switch is flipped on,
-- all users will see the announcement.
INSERT INTO feature_flag_rules (flag_id, type, value, created_by)
SELECT f.id, 'everyone', NULL, NULL
FROM feature_flags f
WHERE f.key = 'beta-to-prod-announcement'
  AND NOT EXISTS (
    SELECT 1 FROM feature_flag_rules r
    WHERE r.flag_id = f.id AND r.type = 'everyone'
  );

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (SELECT id FROM feature_flags WHERE key = 'beta-to-prod-announcement')
  AND type = 'everyone';

DELETE FROM feature_flags WHERE key = 'beta-to-prod-announcement';
