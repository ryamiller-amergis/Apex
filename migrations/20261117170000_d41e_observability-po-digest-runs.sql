-- Up Migration
-- One row per Product Owner digest synthesis run on the V2 document worker.
-- App Service writes the row when it admits the run; the document harvest
-- stores the worker's JSON so every App Service instance reads the same result.

CREATE TABLE observability_po_digest_runs (
  run_id                TEXT        PRIMARY KEY,
  project               TEXT        NOT NULL,
  trend_window          TEXT        NOT NULL,
  slot                  TEXT        NOT NULL,
  model                 TEXT        NOT NULL,
  effort                TEXT        NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'running',
  previous_suggestions  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  synthesis             JSONB,
  failure_detail        TEXT,
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  CONSTRAINT observability_po_digest_runs_status_check
    CHECK (status IN ('running', 'completed', 'failed')),
  CONSTRAINT observability_po_digest_runs_slot_check
    CHECK (slot IN ('morning_6am', 'evening_6pm', 'on_demand'))
);

CREATE INDEX idx_observability_po_digest_runs_project_window
  ON observability_po_digest_runs (project, trend_window, requested_at DESC);

-- Down Migration

DROP TABLE IF EXISTS observability_po_digest_runs;
