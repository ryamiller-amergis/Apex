-- Up Migration: seed playbooks-spike (Phase 0 default-off playbook orchestration spike).
-- Default off with no audience rules. Platform Admin adds local and development targeting to roll
-- out; production and staging stay untargeted for the whole of Phase 0.
--
-- The winning branch and cleanup criterion are recorded in the description at creation rather than
-- decided later, so the flag cannot quietly outlive the spike it gates (TBI-010).
-- Idempotent — safe to re-run.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'playbooks-spike',
  'Gates the Phase 0 playbook orchestration spike: user-composable workflows run by an embedded engine. Winning branch: enabled. Cleanup criterion: retire at acceptance of the Phase 1 definition model.',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (SELECT id FROM feature_flags WHERE key = 'playbooks-spike');

DELETE FROM feature_flags WHERE key = 'playbooks-spike';
