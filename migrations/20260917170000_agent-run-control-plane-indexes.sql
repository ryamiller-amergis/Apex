-- Hot-path indexes for bounded agent-run and Design Doc reconciliation.

-- Up Migration

CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_created
  ON agent_runs (thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_active
  ON agent_runs (thread_id, created_at)
  WHERE status IN ('queued', 'dispatched', 'running');

CREATE INDEX IF NOT EXISTS idx_design_docs_transient_updated
  ON design_docs (status, updated_at, id)
  WHERE status IN ('generating', 'validating');

-- Down Migration

DROP INDEX IF EXISTS idx_design_docs_transient_updated;
DROP INDEX IF EXISTS idx_agent_runs_thread_active;
DROP INDEX IF EXISTS idx_agent_runs_thread_created;
