-- Up Migration

-- TBI-001 DoD-3 / VT-09: every non-terminal run has one absolute hard-crash
-- budget. Existing terminal rows are deliberately untouched.
UPDATE agent_runs
SET timeout_at = COALESCE(started_at, CURRENT_TIMESTAMP) + INTERVAL '2 hours'
WHERE status IN ('queued', 'running')
  AND timeout_at IS NULL;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_non_terminal_timeout_at_check
  CHECK (
    status NOT IN ('queued', 'running')
    OR timeout_at IS NOT NULL
  );

-- Rollout control: disabled preserves the legacy heartbeat/progress authority.
INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'event-driven-run-termination',
  'Makes owner-side MCP deadlines authoritative and retains timeout_at only for hard-crash recovery',
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
  WHERE key = 'event-driven-run-termination'
);

DELETE FROM feature_flags
WHERE key = 'event-driven-run-termination';

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_non_terminal_timeout_at_check;
