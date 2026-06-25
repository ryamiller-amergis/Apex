-- Up Migration
-- Multi-repo project settings: allow a project to own many full settings rows.
-- 1. project_skill_settings gains friendly_name + is_default; UNIQUE(project) is replaced
--    by a one-default-per-project partial unique index and a UNIQUE(project, friendly_name).
-- 2. project_approvers / project_approver_groups are re-keyed from the project text FK to a
--    settings_id UUID FK so approvers belong to a specific repo config, not the whole project.

-- ── 1. project_skill_settings new columns ────────────────────────────────────
ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS friendly_name TEXT,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

-- Backfill: each existing row is the sole config for its project, so it becomes the default
-- and its friendly name defaults to the repo it points at.
UPDATE project_skill_settings SET friendly_name = skill_repo WHERE friendly_name IS NULL;
UPDATE project_skill_settings SET is_default = true;

ALTER TABLE project_skill_settings ALTER COLUMN friendly_name SET NOT NULL;

-- ── 2a. project_approvers → settings_id ──────────────────────────────────────
ALTER TABLE project_approvers ADD COLUMN IF NOT EXISTS settings_id UUID;

UPDATE project_approvers pa
  SET settings_id = pss.id
  FROM project_skill_settings pss
  WHERE pss.project = pa.project;

DROP INDEX IF EXISTS idx_project_approvers_project_type;
ALTER TABLE project_approvers DROP CONSTRAINT IF EXISTS project_approvers_project_user_id_document_type_key;
ALTER TABLE project_approvers DROP CONSTRAINT IF EXISTS project_approvers_project_fkey;
ALTER TABLE project_approvers DROP COLUMN IF EXISTS project;

ALTER TABLE project_approvers ALTER COLUMN settings_id SET NOT NULL;
ALTER TABLE project_approvers
  ADD CONSTRAINT project_approvers_settings_id_fkey
  FOREIGN KEY (settings_id) REFERENCES project_skill_settings(id) ON DELETE CASCADE;
ALTER TABLE project_approvers
  ADD CONSTRAINT project_approvers_settings_user_document_key
  UNIQUE (settings_id, user_id, document_type);
CREATE INDEX IF NOT EXISTS idx_project_approvers_settings_type
  ON project_approvers(settings_id, document_type);

-- ── 2b. project_approver_groups → settings_id ────────────────────────────────
ALTER TABLE project_approver_groups ADD COLUMN IF NOT EXISTS settings_id UUID;

UPDATE project_approver_groups pag
  SET settings_id = pss.id
  FROM project_skill_settings pss
  WHERE pss.project = pag.project;

DROP INDEX IF EXISTS idx_project_approver_groups_project_type;
ALTER TABLE project_approver_groups DROP CONSTRAINT IF EXISTS project_approver_groups_project_group_id_document_type_key;
ALTER TABLE project_approver_groups DROP CONSTRAINT IF EXISTS project_approver_groups_project_fkey;
ALTER TABLE project_approver_groups DROP COLUMN IF EXISTS project;

ALTER TABLE project_approver_groups ALTER COLUMN settings_id SET NOT NULL;
ALTER TABLE project_approver_groups
  ADD CONSTRAINT project_approver_groups_settings_id_fkey
  FOREIGN KEY (settings_id) REFERENCES project_skill_settings(id) ON DELETE CASCADE;
ALTER TABLE project_approver_groups
  ADD CONSTRAINT project_approver_groups_settings_group_document_key
  UNIQUE (settings_id, group_id, document_type);
CREATE INDEX IF NOT EXISTS idx_project_approver_groups_settings_type
  ON project_approver_groups(settings_id, document_type);

-- ── 3. Replace project_skill_settings UNIQUE(project) ────────────────────────
-- Safe now that the approver tables no longer FK the project column.
ALTER TABLE project_skill_settings DROP CONSTRAINT IF EXISTS project_skill_settings_project_key;

CREATE UNIQUE INDEX IF NOT EXISTS project_skill_settings_one_default_per_project
  ON project_skill_settings(project) WHERE is_default;

ALTER TABLE project_skill_settings
  ADD CONSTRAINT project_skill_settings_project_friendly_name_key
  UNIQUE (project, friendly_name);

-- Down Migration

-- ── 3. Restore project_skill_settings UNIQUE(project) ────────────────────────
-- Collapse to one row per project (keep the default) so the unique constraint can be restored.
DELETE FROM project_skill_settings a
  USING project_skill_settings b
  WHERE a.project = b.project AND a.is_default = false AND b.is_default = true;

ALTER TABLE project_skill_settings DROP CONSTRAINT IF EXISTS project_skill_settings_project_friendly_name_key;
DROP INDEX IF EXISTS project_skill_settings_one_default_per_project;
ALTER TABLE project_skill_settings ADD CONSTRAINT project_skill_settings_project_key UNIQUE (project);

-- ── 2b. project_approver_groups → project ────────────────────────────────────
ALTER TABLE project_approver_groups ADD COLUMN IF NOT EXISTS project TEXT;
UPDATE project_approver_groups pag
  SET project = pss.project
  FROM project_skill_settings pss
  WHERE pss.id = pag.settings_id;

DROP INDEX IF EXISTS idx_project_approver_groups_settings_type;
ALTER TABLE project_approver_groups DROP CONSTRAINT IF EXISTS project_approver_groups_settings_group_document_key;
ALTER TABLE project_approver_groups DROP CONSTRAINT IF EXISTS project_approver_groups_settings_id_fkey;
ALTER TABLE project_approver_groups DROP COLUMN IF EXISTS settings_id;

ALTER TABLE project_approver_groups ALTER COLUMN project SET NOT NULL;
ALTER TABLE project_approver_groups
  ADD CONSTRAINT project_approver_groups_project_fkey
  FOREIGN KEY (project) REFERENCES project_skill_settings(project) ON DELETE CASCADE;
ALTER TABLE project_approver_groups
  ADD CONSTRAINT project_approver_groups_project_group_id_document_type_key
  UNIQUE (project, group_id, document_type);
CREATE INDEX IF NOT EXISTS idx_project_approver_groups_project_type
  ON project_approver_groups(project, document_type);

-- ── 2a. project_approvers → project ──────────────────────────────────────────
ALTER TABLE project_approvers ADD COLUMN IF NOT EXISTS project TEXT;
UPDATE project_approvers pa
  SET project = pss.project
  FROM project_skill_settings pss
  WHERE pss.id = pa.settings_id;

DROP INDEX IF EXISTS idx_project_approvers_settings_type;
ALTER TABLE project_approvers DROP CONSTRAINT IF EXISTS project_approvers_settings_user_document_key;
ALTER TABLE project_approvers DROP CONSTRAINT IF EXISTS project_approvers_settings_id_fkey;
ALTER TABLE project_approvers DROP COLUMN IF EXISTS settings_id;

ALTER TABLE project_approvers ALTER COLUMN project SET NOT NULL;
ALTER TABLE project_approvers
  ADD CONSTRAINT project_approvers_project_fkey
  FOREIGN KEY (project) REFERENCES project_skill_settings(project) ON DELETE CASCADE;
ALTER TABLE project_approvers
  ADD CONSTRAINT project_approvers_project_user_id_document_type_key
  UNIQUE (project, user_id, document_type);
CREATE INDEX IF NOT EXISTS idx_project_approvers_project_type
  ON project_approvers(project, document_type);

-- ── 1. project_skill_settings drop new columns ───────────────────────────────
ALTER TABLE project_skill_settings DROP COLUMN IF EXISTS is_default;
ALTER TABLE project_skill_settings DROP COLUMN IF EXISTS friendly_name;
