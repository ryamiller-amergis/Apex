-- Up Migration: Load Testing Module — load_test, load_test_run, load_test_target

-- ── load_test: project-scoped definition table ─────────────────────────────────

CREATE TABLE load_test (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          TEXT        NOT NULL,
  name                TEXT        NOT NULL,
  description         TEXT,
  requirement_ref     JSONB,
  target_url          TEXT        NOT NULL,
  environment         TEXT        NOT NULL,
  engine              TEXT        NOT NULL DEFAULT 'k6'
                                  CHECK (engine IN ('k6')),
  flow_type           TEXT        NOT NULL DEFAULT 'single'
                                  CHECK (flow_type IN ('single', 'multi_step')),
  script_source       TEXT        NOT NULL DEFAULT 'form_builder'
                                  CHECK (script_source IN ('ai_generated', 'form_builder', 'raw')),
  script              TEXT        NOT NULL,
  load_profile        JSONB       NOT NULL DEFAULT '{}',
  client_thresholds   JSONB       NOT NULL DEFAULT '[]',
  run_source          TEXT        CHECK (run_source IN ('app', 'pipeline')),
  secret_refs         JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          TEXT        NOT NULL,
  updated_by          TEXT        NOT NULL
);

CREATE INDEX idx_load_test_project_id
  ON load_test (project_id);

CREATE INDEX idx_load_test_project_created
  ON load_test (project_id, created_at DESC);

-- ── load_test_run: execution table ────────────────────────────────────────────

CREATE TABLE load_test_run (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              TEXT        NOT NULL,
  load_test_id            UUID        NOT NULL REFERENCES load_test(id) ON DELETE RESTRICT,
  status                  TEXT        NOT NULL DEFAULT 'queued'
                                      CHECK (status IN ('queued', 'dispatched', 'running', 'passed', 'failed', 'errored', 'cancelled')),
  run_source              TEXT        NOT NULL DEFAULT 'app'
                                      CHECK (run_source IN ('app', 'pipeline')),
  queued_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  heartbeat_at            TIMESTAMPTZ,
  dispatch_message_id     TEXT,
  cancel_requested        BOOLEAN     NOT NULL DEFAULT false,
  overall_result          TEXT        CHECK (overall_result IN ('passed', 'failed')),
  threshold_results       JSONB,
  summary_artifact_ref    JSONB,
  timeseries_artifact_ref JSONB,
  error_detail            TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_load_test_run_project_id
  ON load_test_run (project_id);

CREATE INDEX idx_load_test_run_project_created
  ON load_test_run (project_id, created_at DESC);

CREATE INDEX idx_load_test_run_load_test_id
  ON load_test_run (load_test_id);

CREATE INDEX idx_load_test_run_status_heartbeat
  ON load_test_run (status, heartbeat_at);

-- ── load_test_target: per-project non-prod target allowlist ────────────────────

CREATE TABLE load_test_target (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        TEXT        NOT NULL,
  base_url          TEXT        NOT NULL,
  environment_label TEXT        NOT NULL,
  is_reachable      BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        TEXT        NOT NULL,
  updated_by        TEXT        NOT NULL
);

CREATE INDEX idx_load_test_target_project_id
  ON load_test_target (project_id);
