-- Up Migration: per-configuration repository checkout readiness on project_skill_settings.
-- Additive columns with defaults — new configs start not_cloned; rolling back app code
-- leaves unused columns harmless.

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS repository_checkout_status text NOT NULL DEFAULT 'not_cloned',
  ADD COLUMN IF NOT EXISTS repository_checkout_sha text,
  ADD COLUMN IF NOT EXISTS repository_checkout_error text,
  ADD COLUMN IF NOT EXISTS repository_checkout_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS repository_checkout_completed_at timestamptz;

-- Constrain status to the known enum values (idempotent via DO block).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_skill_settings_repository_checkout_status_check'
  ) THEN
    ALTER TABLE project_skill_settings
      ADD CONSTRAINT project_skill_settings_repository_checkout_status_check
      CHECK (
        repository_checkout_status IN ('not_cloned', 'cloning', 'ready', 'failed')
      );
  END IF;
END $$;

-- Down Migration

ALTER TABLE project_skill_settings
  DROP CONSTRAINT IF EXISTS project_skill_settings_repository_checkout_status_check;

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS repository_checkout_completed_at,
  DROP COLUMN IF EXISTS repository_checkout_started_at,
  DROP COLUMN IF EXISTS repository_checkout_error,
  DROP COLUMN IF EXISTS repository_checkout_sha,
  DROP COLUMN IF EXISTS repository_checkout_status;
