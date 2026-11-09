-- Up Migration
--
-- Part 1 rollout controls. Both winners are enabled after the observation periods described in
-- design-docs/playbook-product-expansion.plan.md.

INSERT INTO feature_flags (key, description, enabled, lifecycle, cleanup_ready, created_by)
VALUES
  (
    'playbooks-capability-enforcement',
    'Enforces the App-Service-resolved, frozen capability policy for Playbook agent steps. Winning branch: enabled. Cleanup criterion: all active workers enforce the policy and two stable sprints show no legacy fallback.',
    false,
    'active',
    false,
    NULL
  ),
  (
    'playbooks-step-output-artifacts',
    'Stores large Playbook step outputs in private Blob Storage and enables the step output viewer. Winning branch: enabled. Cleanup criterion: two stable sprints with no dangling references or unbounded orphan blobs.',
    false,
    'active',
    false,
    NULL
  )
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id IN (
  SELECT id
  FROM feature_flags
  WHERE key IN (
    'playbooks-capability-enforcement',
    'playbooks-step-output-artifacts'
  )
);

DELETE FROM feature_flags
WHERE key IN (
  'playbooks-capability-enforcement',
  'playbooks-step-output-artifacts'
);
