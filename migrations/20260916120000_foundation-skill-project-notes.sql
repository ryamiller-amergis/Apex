-- Up Migration
-- Per-project release notes for foundation skill releases.
--
-- project_notes maps an Apex project name → { releaseNotes, breakingChanges }.
-- A project without an entry sees no notes: release_notes / breaking_changes
-- stay admin-facing and are never shown to a consumer project.

ALTER TABLE foundation_skill_releases
  ADD COLUMN IF NOT EXISTS project_notes JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN foundation_skill_releases.project_notes IS
  'Per-project release notes. Keys are Apex project names; values are '
  '{ "releaseNotes": string|null, "breakingChanges": string|null }. '
  'Projects absent from this map receive no notes.';

-- Down Migration
-- ALTER TABLE foundation_skill_releases DROP COLUMN IF EXISTS project_notes;
