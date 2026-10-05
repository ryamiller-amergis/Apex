-- Up Migration: seed repo-read-service (Stage 1 in-process bare-repo reader).
-- Default off with no audience rules. Platform Admin adds project/caller rules
-- to roll out. Retain enabled after two stable sprints at full rollout, then
-- retire the working-tree grounding flags (see design-docs/repo-grounding-consolidation.md).
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
  'repo-read-service',
  'Serves AI repository reads from a bare object database at a pinned SHA instead of a materialized working tree',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (SELECT id FROM feature_flags WHERE key = 'repo-read-service');

DELETE FROM feature_flags WHERE key = 'repo-read-service';
