-- Up Migration
CREATE TABLE IF NOT EXISTS deployment_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id TEXT NOT NULL,
  release_version TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production',
  result TEXT NOT NULL,
  downtime_minutes INTEGER,
  details TEXT,
  reported_by TEXT NOT NULL,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deployment_outcomes_release_reported
  ON deployment_outcomes (release_version, reported_at DESC);

-- Down Migration
-- DROP TABLE IF EXISTS deployment_outcomes;
