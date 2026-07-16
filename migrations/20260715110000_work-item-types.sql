-- Generalize feature_requests into typed Apex Backlog work items.

ALTER TABLE feature_requests
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'feature';

ALTER TABLE feature_requests
  ALTER COLUMN advantage DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_feature_requests_type_status_created
  ON feature_requests(type, status, created_at DESC);
