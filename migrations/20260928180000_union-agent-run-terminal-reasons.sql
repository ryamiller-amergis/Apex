-- Up Migration
-- 20260901160000 allowed cloud_agent_timeout and 20260911120000 allowed
-- dispatch_ttl. Each migration replaced the check, so the later one dropped
-- the other reason. Keep both.
ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_terminal_reason_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_terminal_reason_check
    CHECK (
      terminal_reason IS NULL
      OR terminal_reason IN (
        'worker_lost',
        'progress_timeout',
        'queue_ttl',
        'forced_cancel',
        'dispatch_ttl',
        'cloud_agent_timeout'
      )
    );

-- Down Migration
UPDATE agent_runs
  SET terminal_reason = NULL
  WHERE terminal_reason = 'cloud_agent_timeout';

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_terminal_reason_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_terminal_reason_check
    CHECK (
      terminal_reason IS NULL
      OR terminal_reason IN (
        'worker_lost',
        'progress_timeout',
        'queue_ttl',
        'forced_cancel',
        'dispatch_ttl'
      )
    );
