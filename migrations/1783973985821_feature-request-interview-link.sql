-- Up Migration

ALTER TABLE feature_requests
  ADD COLUMN interview_id UUID REFERENCES interviews(id) ON DELETE SET NULL;

-- Down Migration

ALTER TABLE feature_requests
  DROP COLUMN interview_id;