-- Add index on source_project for per-project backlog isolation queries
CREATE INDEX IF NOT EXISTS idx_feature_requests_source_project
  ON feature_requests (source_project);
