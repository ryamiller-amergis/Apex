-- Up Migration
--
-- Phase 2 rollout control for production Playbook adapters and their user surfaces.
-- The enabled branch is retained after two stable internal sprints following acceptance of
-- validation-transition equivalence, spend admission, schema-rendered gates, and pending work.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'playbooks-production-adapters',
  'Gates production Playbook adapters, spend admission, schema-rendered gates, and assigned pending work. Winning branch: enabled. Cleanup criterion: two stable internal sprints after Phase 2 acceptance.',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (
  SELECT id FROM feature_flags WHERE key = 'playbooks-production-adapters'
);

DELETE FROM feature_flags
WHERE key = 'playbooks-production-adapters';
