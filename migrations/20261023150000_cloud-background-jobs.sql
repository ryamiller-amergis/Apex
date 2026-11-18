-- Project-owned Cloud Agent jobs. A job runs when someone presses Run now,
-- or once a day inside a short window after its UTC hour and minute.

-- Up Migration

CREATE TABLE cloud_background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project text NOT NULL,
  name text NOT NULL,
  instructions text NOT NULL,
  skill_path text NOT NULL,
  model text NOT NULL,
  work_item_mode text NOT NULL,
  work_item_id integer,
  schedule_kind text NOT NULL,
  schedule_hour integer,
  schedule_minute integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_started_at timestamptz,
  CONSTRAINT cloud_background_jobs_work_item_mode_check
    CHECK (work_item_mode IN ('create_bug', 'attach', 'none')),
  CONSTRAINT cloud_background_jobs_schedule_kind_check
    CHECK (schedule_kind IN ('manual', 'daily')),
  CONSTRAINT cloud_background_jobs_schedule_minute_check
    CHECK (schedule_minute BETWEEN 0 AND 59),
  CONSTRAINT cloud_background_jobs_schedule_hour_check
    CHECK (
      (schedule_kind = 'manual' AND schedule_hour IS NULL)
      OR (schedule_kind = 'daily' AND schedule_hour BETWEEN 0 AND 23)
    ),
  CONSTRAINT cloud_background_jobs_work_item_check
    CHECK (
      (work_item_mode = 'attach' AND work_item_id IS NOT NULL AND work_item_id > 0)
      OR (work_item_mode <> 'attach' AND work_item_id IS NULL)
    )
);

CREATE INDEX idx_cloud_background_jobs_project ON cloud_background_jobs (project);

CREATE TABLE cloud_background_job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES cloud_background_jobs (id) ON DELETE CASCADE,
  project text NOT NULL,
  agent_run_id text NOT NULL,
  session_id uuid,
  trigger text NOT NULL,
  started_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cloud_background_job_runs_trigger_check
    CHECK (trigger IN ('manual', 'schedule'))
);

CREATE INDEX idx_cloud_background_job_runs_job
  ON cloud_background_job_runs (job_id, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS cloud_background_job_runs;
DROP TABLE IF EXISTS cloud_background_jobs;
