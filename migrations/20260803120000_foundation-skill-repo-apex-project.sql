-- Up Migration
-- Add apex_project to foundation_skill_repo_status.
--
-- The existing `project` column holds the ADO/GitHub project that owns the repo,
-- which is not the same identifier that release targeting uses. Release
-- visibility (target_projects / skill_targets) is keyed on the Apex project
-- name, so without this column we cannot answer "which skills were released to
-- this team" for an observed repo.
--
-- Nullable: rows observed before this migration have no recorded Apex project
-- and are backfilled on their next compatibility check.

ALTER TABLE foundation_skill_repo_status
  ADD COLUMN IF NOT EXISTS apex_project TEXT;

CREATE INDEX IF NOT EXISTS idx_fssrs_apex_project
  ON foundation_skill_repo_status (apex_project);

-- Down Migration
-- DROP INDEX IF EXISTS idx_fssrs_apex_project;
-- ALTER TABLE foundation_skill_repo_status DROP COLUMN IF EXISTS apex_project;
