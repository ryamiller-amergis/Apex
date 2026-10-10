-- Up Migration: Remove the ai-runs-interactive-user-queue feature flag.
-- Queueing chat turns over the per-user limit is part of the V2 interactive path and
-- follows the ai-runs-v2-transport flag. Idempotent — safe to re-run.

DELETE FROM feature_flag_rules
WHERE flag_id = (SELECT id FROM feature_flags WHERE key = 'ai-runs-interactive-user-queue');

DELETE FROM feature_flags WHERE key = 'ai-runs-interactive-user-queue';

-- Down Migration

INSERT INTO feature_flags (key, description, enabled, lifecycle, cleanup_ready, created_by)
VALUES (
  'ai-runs-interactive-user-queue',
  'Queues V2 interactive chat turns over the per-user limit instead of refusing them',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;
