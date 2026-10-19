-- Durable state for bounded, multi-agent Playbook deliberation.

CREATE TABLE playbook_deliberation_sessions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  step_run_id       UUID        NOT NULL UNIQUE
                                REFERENCES playbook_step_runs(id) ON DELETE CASCADE,
  status            TEXT        NOT NULL DEFAULT 'running'
                                CHECK (status IN ('running', 'completed', 'failed')),
  phase             TEXT        NOT NULL DEFAULT 'agenda'
                                CHECK (phase IN ('agenda', 'response', 'rebuttal', 'synthesis', 'completed')),
  charter           TEXT        NOT NULL,
  source_reports    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  agenda            JSONB,
  summary           JSONB,
  max_topics        INTEGER     NOT NULL DEFAULT 5 CHECK (max_topics BETWEEN 1 AND 5),
  max_rounds        INTEGER     NOT NULL DEFAULT 2 CHECK (max_rounds BETWEEN 1 AND 2),
  inquiry_budget    INTEGER     NOT NULL DEFAULT 16 CHECK (inquiry_budget BETWEEN 3 AND 32),
  inquiry_count     INTEGER     NOT NULL DEFAULT 0 CHECK (inquiry_count >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE playbook_deliberation_turns (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID        NOT NULL
                                REFERENCES playbook_deliberation_sessions(id) ON DELETE CASCADE,
  sequence          INTEGER     NOT NULL CHECK (sequence > 0),
  phase             TEXT        NOT NULL
                                CHECK (phase IN ('agenda', 'response', 'rebuttal', 'synthesis')),
  topic_id          TEXT,
  specialist        TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  agent_run_id      TEXT        REFERENCES agent_runs(id) ON DELETE SET NULL,
  thread_id         UUID        REFERENCES chat_threads(id) ON DELETE SET NULL,
  result            JSONB,
  error             TEXT,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_playbook_deliberation_turn_sequence UNIQUE (session_id, sequence)
);

CREATE INDEX idx_playbook_deliberation_turns_session_status
  ON playbook_deliberation_turns (session_id, status, sequence);

CREATE UNIQUE INDEX uq_playbook_deliberation_turn_agent_run
  ON playbook_deliberation_turns (agent_run_id)
  WHERE agent_run_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS uq_playbook_deliberation_turn_agent_run;
DROP INDEX IF EXISTS idx_playbook_deliberation_turns_session_status;
DROP TABLE IF EXISTS playbook_deliberation_turns;
DROP TABLE IF EXISTS playbook_deliberation_sessions;
