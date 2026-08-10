-- Up Migration: seed the shared read-only per-SHA grounding checkout rollout
-- control when absent, targeting the Apex project only. Repository-reading chat
-- callers (Interview, ADR, assistants, Agent Home) share ONE read-only
-- materialized tree per (provider, project, repo, branch, sha) instead of
-- cloning a fresh per-run working tree — removing the "preparing" pause when the
-- target branch has not advanced. enabled=true is required so the evaluator can
-- match the project rule; other projects stay off until Platform Admin adds more
-- audience rules. Idempotent — safe to re-run.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'shared-readonly-grounding-checkout',
  'Reuses one read-only per-SHA grounding checkout across repository-reading chat sessions instead of cloning a per-run working tree',
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
WHERE f.key = 'shared-readonly-grounding-checkout'
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
  WHERE key = 'shared-readonly-grounding-checkout'
)
  AND type = 'project'
  AND value = 'Apex';

DELETE FROM feature_flags
WHERE key = 'shared-readonly-grounding-checkout';
