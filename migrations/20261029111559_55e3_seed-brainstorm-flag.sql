-- Up Migration
--
-- FEAT-001 / TBI-002: kill switch and rollout control for Brainstorm.
-- Seeded off with no rules, so evaluation returns false everywhere until a
-- Platform Admin targets projects for the Internal rollout and enables it.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'brainstorm',
  'Gates Brainstorm: the Agent Home card, the /brainstorm routes and every /api/brainstorm endpoint. Winning branch: enabled. Cleanup criterion: two stable sprints at full rollout.',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (
  SELECT id FROM feature_flags WHERE key = 'brainstorm'
);

DELETE FROM feature_flags
WHERE key = 'brainstorm';
