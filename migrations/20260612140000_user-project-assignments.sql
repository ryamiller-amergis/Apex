-- Up Migration

CREATE TABLE user_project_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  project TEXT NOT NULL,
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, project)
);

CREATE INDEX idx_user_project_assignments_user_id ON user_project_assignments(user_id);
CREATE INDEX idx_user_project_assignments_project ON user_project_assignments(project);

-- Down Migration

DROP TABLE IF EXISTS user_project_assignments;
