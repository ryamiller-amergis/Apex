-- Up Migration
--
-- FEAT-002 / TBI-004: kill switch and rollout control for Build from Prompt.
-- Seeded off with no rules, so evaluation returns false everywhere until a
-- Platform Admin adds user rules for the Internal rollout and enables it.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'build-from-prompt',
  'Gates Build from Prompt: the Builds menu and route, start and action routes, and Cloud Agent launches. Winning branch: enabled. Cleanup criterion: two stable sprints at full rollout.',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (
  SELECT id FROM feature_flags WHERE key = 'build-from-prompt'
);

DELETE FROM feature_flags
WHERE key = 'build-from-prompt';
