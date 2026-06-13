-- Up Migration

CREATE TABLE project_access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  project TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT
);

CREATE INDEX idx_project_access_requests_user_id ON project_access_requests(user_id);
CREATE INDEX idx_project_access_requests_status ON project_access_requests(status);
CREATE INDEX idx_project_access_requests_project ON project_access_requests(project);
CREATE UNIQUE INDEX idx_project_access_requests_pending_unique
  ON project_access_requests(user_id, lower(project))
  WHERE status = 'pending';

-- Down Migration

DROP TABLE IF EXISTS project_access_requests;
