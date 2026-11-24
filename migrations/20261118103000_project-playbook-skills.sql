-- Up Migration
--
-- Project-owned Playbook skills. Foundation skills stay files and are not copied here.
-- A published Playbook pins one version. Later edits insert a new version.

CREATE TABLE IF NOT EXISTS project_playbook_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project text NOT NULL,
  name text NOT NULL,
  created_by text NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_playbook_skills_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT project_playbook_skills_project_not_blank CHECK (length(btrim(project)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_playbook_skills_project_name
  ON project_playbook_skills (project, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS project_playbook_skill_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES project_playbook_skills(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  content text NOT NULL,
  skill_type text,
  output_kind text,
  content_sha256 text NOT NULL,
  bundle_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_by text NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_playbook_skill_versions_number_check CHECK (version_number >= 1),
  CONSTRAINT project_playbook_skill_versions_status_check CHECK (status IN ('draft', 'published')),
  CONSTRAINT project_playbook_skill_versions_content_size_check CHECK (octet_length(content) <= 200000),
  CONSTRAINT project_playbook_skill_versions_sha_check CHECK (
    content_sha256 ~ '^[a-f0-9]{64}$' AND bundle_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT uq_project_playbook_skill_versions_number UNIQUE (skill_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_project_playbook_skill_versions_skill
  ON project_playbook_skill_versions (skill_id, version_number);

CREATE TABLE IF NOT EXISTS project_playbook_skill_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES project_playbook_skill_versions(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  content text NOT NULL,
  classification text NOT NULL,
  approval_status text NOT NULL DEFAULT 'pending',
  CONSTRAINT project_playbook_skill_files_name_check CHECK (
    file_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$' AND file_name <> 'SKILL.md'
  ),
  CONSTRAINT project_playbook_skill_files_class_check CHECK (classification IN ('instruction', 'reference')),
  CONSTRAINT project_playbook_skill_files_approval_check CHECK (approval_status IN ('pending', 'approved')),
  CONSTRAINT project_playbook_skill_files_size_check CHECK (octet_length(content) <= 200000),
  CONSTRAINT uq_project_playbook_skill_files_name UNIQUE (version_id, file_name)
);

-- Down Migration

DROP TABLE IF EXISTS project_playbook_skill_files;
DROP TABLE IF EXISTS project_playbook_skill_versions;
DROP TABLE IF EXISTS project_playbook_skills;
