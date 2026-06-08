-- Up Migration

-- Reusable, organizational user groups (e.g. Developers, Product, UI/UX).
-- Fully separate from RBAC app_roles, which are permission-based.
CREATE TABLE IF NOT EXISTS app_groups (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        UNIQUE NOT NULL,
  description TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Membership of users within a group.
CREATE TABLE IF NOT EXISTS app_group_members (
  group_id UUID        NOT NULL REFERENCES app_groups(id) ON DELETE CASCADE,
  user_id  TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  added_by TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_app_group_members_user ON app_group_members(user_id);

-- Live group references in a project's approver pool, keyed by (project, group, document_type).
CREATE TABLE IF NOT EXISTS project_approver_groups (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project       TEXT        NOT NULL REFERENCES project_skill_settings(project) ON DELETE CASCADE,
  group_id      UUID        NOT NULL REFERENCES app_groups(id) ON DELETE CASCADE,
  document_type TEXT        NOT NULL CHECK (document_type IN ('design_doc', 'prd')),
  assigned_by   TEXT,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project, group_id, document_type)
);

CREATE INDEX IF NOT EXISTS idx_project_approver_groups_project_type ON project_approver_groups(project, document_type);

-- Kick-off approver selections stored on the interview, inherited at submit-for-review.
ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS prd_approver_ids        JSONB,
  ADD COLUMN IF NOT EXISTS design_doc_approver_ids JSONB;

-- Down Migration

ALTER TABLE interviews
  DROP COLUMN IF EXISTS prd_approver_ids,
  DROP COLUMN IF EXISTS design_doc_approver_ids;

DROP TABLE IF EXISTS project_approver_groups;
DROP TABLE IF EXISTS app_group_members;
DROP TABLE IF EXISTS app_groups;
