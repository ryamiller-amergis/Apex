-- Migration: add skill_targets column to foundation_skill_releases
--
-- skill_targets is a JSONB object mapping skill name → target project list.
-- An empty object {} means all skills inherit the release-level target_projects.
-- A non-empty entry for a skill name overrides target_projects for that skill only.
-- Resolution rule: skill_targets[skillName] ?? release.target_projects
--
-- Up

ALTER TABLE foundation_skill_releases
  ADD COLUMN IF NOT EXISTS skill_targets JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN foundation_skill_releases.skill_targets IS
  'Per-skill project targeting overrides. Keys are skill names; values are string[] '
  'project allowlists. Empty array for a skill means "all projects". '
  'Skills absent from this map inherit the release-level target_projects.';

-- Down
-- ALTER TABLE foundation_skill_releases DROP COLUMN IF EXISTS skill_targets;
