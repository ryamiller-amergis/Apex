-- Up Migration: seed the FEAT-003 grounding lifecycle rollout control.
-- Disabled by default; Platform Admin adds internal targeting before gradual rollout.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'repo-grounding-lifecycle-binding',
  'Recreates Cursor agents when their persisted grounding mode or commit binding changes',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (
  SELECT id
  FROM feature_flags
  WHERE key = 'repo-grounding-lifecycle-binding'
);

DELETE FROM feature_flags
WHERE key = 'repo-grounding-lifecycle-binding';
