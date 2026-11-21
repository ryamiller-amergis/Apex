-- Up Migration
-- Persists interactive turn stage timings (time-to-first-token, workspace prep,
-- agent acquisition mode, worker turn duration) so Platform Admin AI Experience
-- can chart perceived speed and session warmth alongside Application Insights.

CREATE TABLE ai_turn_stage_timings (
  run_id                    TEXT        PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  thread_id                 TEXT        NOT NULL,
  project_id                TEXT,
  area                      TEXT,
  workflow_class            TEXT,
  status                    TEXT        NOT NULL,
  agent_mode                TEXT        NOT NULL DEFAULT 'unknown',
  recreate_reason           TEXT,
  grounded                  BOOLEAN     NOT NULL DEFAULT false,
  workspace_ms              INTEGER,
  agent_acquire_ms          INTEGER,
  first_event_ms            INTEGER,
  first_token_ms            INTEGER,
  worker_turn_ms            INTEGER,
  admitted_to_terminal_ms   INTEGER,
  dispatched_to_terminal_ms INTEGER,
  recorded_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_turn_stage_timings_status_check
    CHECK (status IN ('completed', 'failed', 'cancelled')),
  CONSTRAINT ai_turn_stage_timings_agent_mode_check
    CHECK (agent_mode IN ('warm', 'resumed', 'recreated', 'unknown')),
  CONSTRAINT ai_turn_stage_timings_non_negative_ms_check
    CHECK (
      (workspace_ms IS NULL OR workspace_ms >= 0)
      AND (agent_acquire_ms IS NULL OR agent_acquire_ms >= 0)
      AND (first_event_ms IS NULL OR first_event_ms >= 0)
      AND (first_token_ms IS NULL OR first_token_ms >= 0)
      AND (worker_turn_ms IS NULL OR worker_turn_ms >= 0)
      AND (admitted_to_terminal_ms IS NULL OR admitted_to_terminal_ms >= 0)
      AND (dispatched_to_terminal_ms IS NULL OR dispatched_to_terminal_ms >= 0)
    )
);

CREATE INDEX idx_ai_turn_stage_timings_recorded
  ON ai_turn_stage_timings (recorded_at DESC);

CREATE INDEX idx_ai_turn_stage_timings_area_recorded
  ON ai_turn_stage_timings (area, recorded_at DESC);

CREATE INDEX idx_ai_turn_stage_timings_project_recorded
  ON ai_turn_stage_timings (project_id, recorded_at DESC)
  WHERE project_id IS NOT NULL;

-- Down Migration

DROP TABLE IF EXISTS ai_turn_stage_timings;
