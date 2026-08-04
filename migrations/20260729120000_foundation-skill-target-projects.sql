-- Up Migration
-- Add target_projects column to foundation_skill_releases.
-- Empty array (default) means the release is visible to ALL Apex projects.
-- Non-empty means the release is restricted to the listed Apex project names.

ALTER TABLE foundation_skill_releases
  ADD COLUMN IF NOT EXISTS target_projects JSONB NOT NULL DEFAULT '[]';

-- Down Migration
-- ALTER TABLE foundation_skill_releases DROP COLUMN IF EXISTS target_projects;
