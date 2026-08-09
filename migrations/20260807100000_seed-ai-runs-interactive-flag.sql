-- Up Migration: seed the FEAT-007 interactive-lane rollout control when absent,
-- and target the Apex project only. enabled=true is required so the evaluator
-- can match the project rule; other projects stay off until Platform Admin adds
-- more audience rules. Idempotent — safe to re-run.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'ai-runs-interactive',
  'Routes interactive chat turns (Interview, ADR, Agent Home) through the WebSocket gateway and warm Dapr actor lane',
  true,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Apex-only audience rule. ANDed with any future caller/environment rules.
INSERT INTO feature_flag_rules (flag_id, type, value, created_by)
SELECT f.id, 'project', 'Apex', NULL
FROM feature_flags f
WHERE f.key = 'ai-runs-interactive'
  AND NOT EXISTS (
    SELECT 1 FROM feature_flag_rules r
    WHERE r.flag_id = f.id
      AND r.type = 'project'
      AND r.value = 'Apex'
  );

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (
  SELECT id
  FROM feature_flags
  WHERE key = 'ai-runs-interactive'
)
  AND type = 'project'
  AND value = 'Apex';

DELETE FROM feature_flags
WHERE key = 'ai-runs-interactive';
