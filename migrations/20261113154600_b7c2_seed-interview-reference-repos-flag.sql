-- Up Migration
--
-- Gates Interview reference repositories. Seeded off with no rules, so
-- evaluation returns false everywhere until a Platform Admin targets projects.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'interview-reference-repos',
  'Gates Interview reference repositories: the Reference repositories section of an Interview''s Linked Context panel, the /api/interviews/:id/reference-repositories endpoints, and mounting those Brainstorm catalog repositories on Technical-phase Interview turns. Winning branch: enabled. Cleanup criterion: two stable sprints at full rollout.',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (
  SELECT id FROM feature_flags WHERE key = 'interview-reference-repos'
);

DELETE FROM feature_flags
WHERE key = 'interview-reference-repos';
