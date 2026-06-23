CREATE TABLE pending_project_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  project TEXT NOT NULL,
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(email, project)
);

CREATE INDEX idx_pending_project_assignments_email
  ON pending_project_assignments(LOWER(email));
