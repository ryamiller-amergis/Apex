-- Up Migration: Deployment B Apex cutover for admin-managed repository checkouts.
-- Seeds project-repository-checkout-readiness ON for Apex and removes Apex audience
-- rules from the four superseded grounding flags so those behaviors are no longer
-- targeted for Apex. Does not delete catalog rows (full archive is a later cleanup).
-- Leave native-read / ai-runs-* / event-driven-run-termination untouched.
-- Apply only after admin Clone has produced mirrors + .apex-shared-ready for Apex configs.

-- Ensure superseded flag rows exist so rule deletion is a no-op when absent.
INSERT INTO feature_flags (key, description, enabled, lifecycle, cleanup_ready, created_by)
VALUES
  (
    'shared-readonly-grounding-checkout',
    'Reuses one read-only per-SHA grounding checkout across repository-reading chat sessions instead of cloning a per-run working tree',
    true,
    'active',
    false,
    NULL
  ),
  (
    'repo-grounding-workspace-profile',
    'Enables durable run grounding / workspace profile for repository-aware AI',
    true,
    'active',
    false,
    NULL
  ),
  (
    'repo-grounding-lifecycle-binding',
    'Recreates agent boundary when grounding SHA changes on explicit re-ground',
    false,
    'active',
    false,
    NULL
  ),
  (
    'repo-grounding-remote-search-convergence',
    'Converges remote search behavior for repository grounding',
    true,
    'active',
    false,
    NULL
  )
ON CONFLICT (key) DO NOTHING;

-- Snapshot Apex rules for the four superseded flags so down can restore them.
CREATE TABLE IF NOT EXISTS _apex_checkout_cutover_rule_backup (
  flag_key text NOT NULL,
  type text NOT NULL,
  value text NOT NULL,
  PRIMARY KEY (flag_key, type, value)
);

INSERT INTO _apex_checkout_cutover_rule_backup (flag_key, type, value)
SELECT f.key, r.type, r.value
FROM feature_flag_rules r
JOIN feature_flags f ON f.id = r.flag_id
WHERE f.key IN (
  'shared-readonly-grounding-checkout',
  'repo-grounding-workspace-profile',
  'repo-grounding-lifecycle-binding',
  'repo-grounding-remote-search-convergence'
)
  AND r.type = 'project'
  AND r.value = 'Apex'
ON CONFLICT DO NOTHING;

DELETE FROM feature_flag_rules
WHERE type = 'project'
  AND value = 'Apex'
  AND flag_id IN (
    SELECT id FROM feature_flags
    WHERE key IN (
      'shared-readonly-grounding-checkout',
      'repo-grounding-workspace-profile',
      'repo-grounding-lifecycle-binding',
      'repo-grounding-remote-search-convergence'
    )
  );

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'project-repository-checkout-readiness',
  'Admin-managed repository checkouts: Project Admin Clone is the only cold clone; roots fetch-and-pin; descendants inherit SHA; hard readiness gate for repository-dependent AI',
  true,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Apex-only audience rule. enabled=true is required so the evaluator can match.
INSERT INTO feature_flag_rules (flag_id, type, value, created_by)
SELECT f.id, 'project', 'Apex', NULL
FROM feature_flags f
WHERE f.key = 'project-repository-checkout-readiness'
  AND NOT EXISTS (
    SELECT 1 FROM feature_flag_rules r
    WHERE r.flag_id = f.id
      AND r.type = 'project'
      AND r.value = 'Apex'
  );

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (
  SELECT id FROM feature_flags WHERE key = 'project-repository-checkout-readiness'
)
  AND type = 'project'
  AND value = 'Apex';

DELETE FROM feature_flags
WHERE key = 'project-repository-checkout-readiness';

-- Restore Apex rules that existed before cutover.
INSERT INTO feature_flag_rules (flag_id, type, value, created_by)
SELECT f.id, b.type, b.value, NULL
FROM _apex_checkout_cutover_rule_backup b
JOIN feature_flags f ON f.key = b.flag_key
WHERE NOT EXISTS (
  SELECT 1 FROM feature_flag_rules r
  WHERE r.flag_id = f.id
    AND r.type = b.type
    AND r.value = b.value
);

DROP TABLE IF EXISTS _apex_checkout_cutover_rule_backup;
