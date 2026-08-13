-- Up Migration: async repository checkout jobs + admin progress on skill settings.
-- Job row is the claim/lease source of truth; progress columns are polled via GET readiness.

CREATE TABLE IF NOT EXISTS repository_checkout_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_settings_id uuid NOT NULL REFERENCES project_skill_settings(id) ON DELETE CASCADE,
  refresh boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  owner_instance text,
  heartbeat_at timestamptz,
  lock_expires_at timestamptz,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repository_checkout_jobs_status_check
    CHECK (status IN ('queued', 'claimed', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_repository_checkout_jobs_status_created
  ON repository_checkout_jobs (status, created_at);

CREATE INDEX IF NOT EXISTS idx_repository_checkout_jobs_claim
  ON repository_checkout_jobs (created_at)
  WHERE status = 'queued';

CREATE UNIQUE INDEX IF NOT EXISTS idx_repository_checkout_jobs_one_inflight
  ON repository_checkout_jobs (skill_settings_id)
  WHERE status IN ('queued', 'claimed');

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS repository_checkout_progress_percent integer,
  ADD COLUMN IF NOT EXISTS repository_checkout_progress_label text;

-- Down Migration

DROP INDEX IF EXISTS idx_repository_checkout_jobs_one_inflight;
DROP INDEX IF EXISTS idx_repository_checkout_jobs_claim;
DROP INDEX IF EXISTS idx_repository_checkout_jobs_status_created;
DROP TABLE IF EXISTS repository_checkout_jobs;

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS repository_checkout_progress_label,
  DROP COLUMN IF EXISTS repository_checkout_progress_percent;
