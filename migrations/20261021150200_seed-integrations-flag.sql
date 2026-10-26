-- Up Migration
-- Project-targeted Integrations module. Off until the kill switch is enabled
-- and a project rule matches. Retain the enabled branch after two stable
-- sprints at full rollout.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'integrations',
  'Project-targeted Integrations module. Off until enabled with a project rule. Winner is the enabled branch after two stable sprints at full rollout.',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flags WHERE key = 'integrations';
