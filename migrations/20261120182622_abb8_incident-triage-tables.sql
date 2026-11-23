-- Up Migration
-- ServiceNow incident triage storage. One settings row per project, one row per
-- ServiceNow incident (text already redacted), and one row per AI analysis run.
-- The webhook column holds an encrypted envelope, never the raw Teams URL.

CREATE TABLE incident_triage_settings (
  project               TEXT        PRIMARY KEY,
  enabled               BOOLEAN     NOT NULL DEFAULT false,
  assignment_group_ids  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  backfill_days         INTEGER     NOT NULL DEFAULT 7,
  watermark             TIMESTAMPTZ,
  last_sweep_at         TIMESTAMPTZ,
  last_sweep_error      TEXT,
  teams_webhook         JSONB,
  updated_by            TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE incident_triage_incidents (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project                 TEXT        NOT NULL,
  sys_id                  TEXT        NOT NULL,
  number                  TEXT        NOT NULL,
  short_description       TEXT,
  description             TEXT,
  close_notes             TEXT,
  state                   TEXT,
  priority                TEXT,
  impact                  TEXT,
  urgency                 TEXT,
  category                TEXT,
  subcategory             TEXT,
  assignment_group_name   TEXT,
  close_code              TEXT,
  opened_at               TIMESTAMPTZ,
  resolved_at             TIMESTAMPTZ,
  sys_updated_on          TIMESTAMPTZ,
  content_hash            TEXT        NOT NULL,
  first_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT incident_triage_incidents_project_sys_id_key
    UNIQUE (project, sys_id)
);

CREATE INDEX idx_incident_triage_incidents_project_updated
  ON incident_triage_incidents (project, sys_updated_on DESC);

CREATE TABLE incident_triage_analyses (
  run_id          UUID        PRIMARY KEY,
  incident_id     UUID        NOT NULL REFERENCES incident_triage_incidents(id) ON DELETE CASCADE,
  content_hash    TEXT        NOT NULL,
  sys_updated_on  TIMESTAMPTZ,
  status          TEXT        NOT NULL,
  requested_by    TEXT,
  model           TEXT,
  effort          TEXT,
  repository      TEXT,
  grounded_sha    TEXT,
  verdict         TEXT,
  area            TEXT,
  severity        TEXT,
  result          JSONB,
  failure_detail  TEXT,
  teams_status    TEXT        NOT NULL DEFAULT 'pending',
  teams_attempts  INTEGER     NOT NULL DEFAULT 0,
  teams_posted_at TIMESTAMPTZ,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  CONSTRAINT incident_triage_analyses_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  CONSTRAINT incident_triage_analyses_teams_status_check
    CHECK (teams_status IN ('pending', 'posted', 'failed', 'skipped'))
);

-- A scheduled sweep (requested_by IS NULL) analyzes one content hash once.
-- Manual re-analysis by a person may repeat a hash.
CREATE UNIQUE INDEX uq_incident_triage_analyses_scheduled
  ON incident_triage_analyses (incident_id, content_hash)
  WHERE requested_by IS NULL;

CREATE INDEX idx_incident_triage_analyses_status
  ON incident_triage_analyses (status);

-- Down Migration

DROP TABLE IF EXISTS incident_triage_analyses;
DROP TABLE IF EXISTS incident_triage_incidents;
DROP TABLE IF EXISTS incident_triage_settings;
