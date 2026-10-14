-- Migration: repository-level audience for foundation skill releases
--
-- target_repos lists the Project Settings repositories that may see and install
-- a release. An empty array keeps the older behavior: every repository under
-- target_projects is included. When a project has rows here, only those
-- repositories see the release and the update banner.
--
-- Up

ALTER TABLE foundation_skill_releases
  ADD COLUMN IF NOT EXISTS target_repos JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN foundation_skill_releases.target_repos IS
  'Repository allowlist. Each entry is { apexProject, provider, project, repo, branch, friendlyName }. '
  'Empty array means every repository under target_projects. '
  'A project with entries is limited to those repositories.';

-- Down
-- ALTER TABLE foundation_skill_releases DROP COLUMN IF EXISTS target_repos;
