-- Up Migration

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS progress_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS progress_label TEXT,
  ADD COLUMN IF NOT EXISTS progress_phase TEXT;

ALTER TABLE dev_sessions
  ADD COLUMN IF NOT EXISTS setup_phase TEXT,
  ADD COLUMN IF NOT EXISTS setup_detail TEXT,
  ADD COLUMN IF NOT EXISTS setup_progress_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS agent_run_events (
  event_id        UUID        PRIMARY KEY,
  ordinal         BIGSERIAL   NOT NULL UNIQUE,
  thread_id       TEXT        NOT NULL,
  run_id          TEXT        NOT NULL,
  source_instance TEXT        NOT NULL,
  sequence        INTEGER     NOT NULL,
  event_timestamp TIMESTAMPTZ NOT NULL,
  event_type      TEXT        NOT NULL,
  phase           TEXT        NOT NULL,
  status          TEXT        NOT NULL,
  detail          TEXT,
  event           JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_run_events_source_sequence_key UNIQUE (run_id, source_instance, sequence)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_thread_ordinal
  ON agent_run_events (thread_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_sequence
  ON agent_run_events (run_id, sequence);

-- Down Migration

DROP TABLE IF EXISTS agent_run_events;

ALTER TABLE dev_sessions
  DROP COLUMN IF EXISTS setup_progress_at,
  DROP COLUMN IF EXISTS setup_detail,
  DROP COLUMN IF EXISTS setup_phase;

ALTER TABLE agent_runs
  DROP COLUMN IF EXISTS progress_phase,
  DROP COLUMN IF EXISTS progress_label,
  DROP COLUMN IF EXISTS progress_at;
