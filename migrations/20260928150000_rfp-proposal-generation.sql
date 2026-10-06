-- RFP intake: generated product proposals.
-- One review submission queues a leased PostgreSQL job that researches official
-- prices and writes an editable admin draft. The published `proposal` column
-- stays separate from the generated draft.

-- Up Migration

CREATE TABLE IF NOT EXISTS rfp_proposal_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_request_id UUID NOT NULL REFERENCES rfp_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  verdict TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  requested_by TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  owner_instance TEXT,
  heartbeat_at TIMESTAMPTZ,
  lock_expires_at TIMESTAMPTZ,
  draft JSONB,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rfp_proposal_jobs_kind_check CHECK (kind IN ('proposal', 'decision-summary')),
  CONSTRAINT rfp_proposal_jobs_status_check CHECK (
    status IN ('queued', 'researching-prices', 'writing', 'ready', 'failed', 'superseded')
  ),
  CONSTRAINT rfp_proposal_jobs_attempts_check CHECK (attempts >= 0 AND max_attempts >= 1)
);

-- At most one active job per request; a new submission supersedes the old one first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rfp_proposal_jobs_one_active
  ON rfp_proposal_jobs (rfp_request_id)
  WHERE status IN ('queued', 'researching-prices', 'writing');

CREATE INDEX IF NOT EXISTS idx_rfp_proposal_jobs_claim
  ON rfp_proposal_jobs (status, available_at, created_at);

CREATE INDEX IF NOT EXISTS idx_rfp_proposal_jobs_request_created
  ON rfp_proposal_jobs (rfp_request_id, created_at);

ALTER TABLE rfp_requests
  ADD COLUMN IF NOT EXISTS review_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_submitted_by TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS current_proposal_job_id UUID REFERENCES rfp_proposal_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposal_draft JSONB;

-- Down Migration

ALTER TABLE rfp_requests
  DROP COLUMN IF EXISTS proposal_draft,
  DROP COLUMN IF EXISTS current_proposal_job_id,
  DROP COLUMN IF EXISTS review_submitted_by,
  DROP COLUMN IF EXISTS review_submitted_at;

DROP INDEX IF EXISTS idx_rfp_proposal_jobs_request_created;
DROP INDEX IF EXISTS idx_rfp_proposal_jobs_claim;
DROP INDEX IF EXISTS idx_rfp_proposal_jobs_one_active;
DROP TABLE IF EXISTS rfp_proposal_jobs;
