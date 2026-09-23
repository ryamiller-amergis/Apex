-- Up Migration
-- A background run in `dispatched` had no terminal path: the admission sweep
-- republished it on every pass instead of ever failing it, so waiters blocked
-- on a run that read neither alive nor terminal. The reaper now applies a
-- dispatch TTL, which needs its own reason to stay separable from the
-- heartbeat-loss case already reported as `worker_lost`.
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

-- Down Migration
-- Existing rows must be remapped before the narrower constraint can be added.
UPDATE agent_runs
  SET terminal_reason = 'worker_lost'
  WHERE terminal_reason = 'dispatch_ttl';

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
        'forced_cancel'
      )
    );
