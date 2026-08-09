-- Up Migration: seed the TBI-007 background-run rollout control when absent.
-- It starts disabled with zero targeting rules. Platform Admin represents each
-- rollout stage by adding project + caller rules, where caller is one of
-- prd, design-doc, validation, test-cases. These dimensions are ANDed by the
-- existing evaluator, so no internal project is hardcoded in this migration.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'ai-runs-background',
  'Routes eligible generation workflows through the bounded background worker tier',
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
  WHERE key = 'ai-runs-background'
);

DELETE FROM feature_flags
WHERE key = 'ai-runs-background';
