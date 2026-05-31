CREATE TABLE IF NOT EXISTS project_approvers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL REFERENCES project_skill_settings(project) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('design_doc', 'prd')),
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project, user_id, document_type)
);

CREATE INDEX IF NOT EXISTS idx_project_approvers_project_type ON project_approvers(project, document_type);
