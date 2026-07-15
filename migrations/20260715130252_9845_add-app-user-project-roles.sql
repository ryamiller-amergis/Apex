-- Up Migration

CREATE TABLE app_user_project_roles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  project     TEXT        NOT NULL,
  role_id     UUID        NOT NULL REFERENCES app_roles(id) ON DELETE CASCADE,
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_user_project_roles_user_project_role_key UNIQUE (user_id, project, role_id)
);

CREATE INDEX idx_app_user_project_roles_user_project
  ON app_user_project_roles (user_id, project);

-- Down Migration

DROP TABLE IF EXISTS app_user_project_roles;
