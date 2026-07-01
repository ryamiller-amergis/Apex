-- Feature Requests table

CREATE TABLE IF NOT EXISTS feature_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  request TEXT NOT NULL,
  advantage TEXT NOT NULL,
  submitted_by TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  source_project TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  ai_status TEXT NOT NULL DEFAULT 'pending',
  ai_priority TEXT,
  ai_risk TEXT,
  ai_rationale TEXT,
  ai_thread_id TEXT,
  team_priority TEXT,
  team_risk TEXT,
  rank INTEGER,
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feature_requests_status_created
  ON feature_requests(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feature_requests_submitted_by
  ON feature_requests(submitted_by);
