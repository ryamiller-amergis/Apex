-- Up Migration: Insert the ai-runs-interactive-user-queue feature flag (off).
-- When on, a V2 interactive chat turn sent while the user is at their running-turn
-- limit is accepted and waits for a free slot (up to 15 minutes, at most 3 waiting)
-- instead of being refused. Idempotent — safe to re-run.

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

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (SELECT id FROM feature_flags WHERE key = 'ai-runs-interactive-user-queue');

DELETE FROM feature_flags WHERE key = 'ai-runs-interactive-user-queue';
