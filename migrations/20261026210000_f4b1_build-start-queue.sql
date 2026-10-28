-- Up Migration
-- FEAT-004: a queued build has no Playbook run until it is promoted, and the
-- queue is ordered by queued_at. playbook_run_id may be filled in once, from
-- null, and may not change after that. A queued build can be suspended.

ALTER TABLE build_runs ALTER COLUMN playbook_run_id DROP NOT NULL;

ALTER TABLE build_runs
  ADD COLUMN queued_at timestamptz,
  ADD COLUMN skill_settings_id uuid;

ALTER TABLE build_runs
  ADD CONSTRAINT fk_build_runs_skill_settings
  FOREIGN KEY (skill_settings_id) REFERENCES project_skill_settings (id) ON DELETE SET NULL;

ALTER TABLE build_runs DROP CONSTRAINT build_runs_suspended_from_status_check;
ALTER TABLE build_runs ADD CONSTRAINT build_runs_suspended_from_status_check CHECK (
  suspended_from_status IS NULL OR suspended_from_status IN (
    'queued', 'intake', 'planning', 'building', 'checking', 'deploying'
  )
);

CREATE INDEX idx_build_runs_queued_at ON build_runs (project, queued_at)
  WHERE status = 'queued';

CREATE OR REPLACE FUNCTION build_runs_frozen_columns_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.skill_snapshot IS DISTINCT FROM OLD.skill_snapshot
     OR NEW.support_contacts IS DISTINCT FROM OLD.support_contacts
     OR NEW.quality_manifest_snapshot IS DISTINCT FROM OLD.quality_manifest_snapshot
     OR NEW.prompt IS DISTINCT FROM OLD.prompt
     OR NEW.project IS DISTINCT FROM OLD.project
     OR NEW.repository IS DISTINCT FROM OLD.repository
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
  THEN
    RAISE EXCEPTION 'build_runs frozen columns cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.playbook_run_id IS NOT NULL
     AND NEW.playbook_run_id IS DISTINCT FROM OLD.playbook_run_id
  THEN
    RAISE EXCEPTION 'build_runs frozen columns cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.integration_branch IS NOT NULL
     AND NEW.integration_branch IS DISTINCT FROM OLD.integration_branch
  THEN
    RAISE EXCEPTION 'integration_branch is write-once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.base_commit IS NOT NULL
     AND NEW.base_commit IS DISTINCT FROM OLD.base_commit
  THEN
    RAISE EXCEPTION 'base_commit is write-once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Down Migration

DROP INDEX IF EXISTS idx_build_runs_queued_at;

ALTER TABLE build_runs DROP CONSTRAINT IF EXISTS fk_build_runs_skill_settings;
ALTER TABLE build_runs DROP COLUMN IF EXISTS skill_settings_id;
ALTER TABLE build_runs DROP COLUMN IF EXISTS queued_at;

ALTER TABLE build_runs DROP CONSTRAINT build_runs_suspended_from_status_check;
ALTER TABLE build_runs ADD CONSTRAINT build_runs_suspended_from_status_check CHECK (
  suspended_from_status IS NULL OR suspended_from_status IN (
    'intake', 'planning', 'building', 'checking', 'deploying'
  )
);

CREATE OR REPLACE FUNCTION build_runs_frozen_columns_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.skill_snapshot IS DISTINCT FROM OLD.skill_snapshot
     OR NEW.support_contacts IS DISTINCT FROM OLD.support_contacts
     OR NEW.quality_manifest_snapshot IS DISTINCT FROM OLD.quality_manifest_snapshot
     OR NEW.prompt IS DISTINCT FROM OLD.prompt
     OR NEW.project IS DISTINCT FROM OLD.project
     OR NEW.repository IS DISTINCT FROM OLD.repository
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.playbook_run_id IS DISTINCT FROM OLD.playbook_run_id
  THEN
    RAISE EXCEPTION 'build_runs frozen columns cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.integration_branch IS NOT NULL
     AND NEW.integration_branch IS DISTINCT FROM OLD.integration_branch
  THEN
    RAISE EXCEPTION 'integration_branch is write-once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.base_commit IS NOT NULL
     AND NEW.base_commit IS DISTINCT FROM OLD.base_commit
  THEN
    RAISE EXCEPTION 'base_commit is write-once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Fails when a queued row still has a null playbook run. Cancel those builds before rolling this back.
ALTER TABLE build_runs ALTER COLUMN playbook_run_id SET NOT NULL;
