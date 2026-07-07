-- Agent runs table: Postgres as source of truth for run status across workers.
CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  owner_instance TEXT,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  timeout_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_runs_status_heartbeat ON agent_runs (status, heartbeat_at);
