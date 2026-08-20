-- Reviewer override on an RFP intake (AI evaluation versions stay immutable)

-- Up Migration

ALTER TABLE rfp_requests
  ADD COLUMN IF NOT EXISTS reviewer_verdict TEXT,
  ADD COLUMN IF NOT EXISTS reviewer_rationale TEXT,
  ADD COLUMN IF NOT EXISTS reviewer_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewer_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewer_source_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE rfp_requests
  DROP CONSTRAINT IF EXISTS rfp_requests_reviewer_verdict_check;

ALTER TABLE rfp_requests
  ADD CONSTRAINT rfp_requests_reviewer_verdict_check CHECK (
    reviewer_verdict IS NULL OR reviewer_verdict IN (
      'build', 'rent-and-wrap', 'rent', 'buy', 'decline', 'needs-clarification'
    )
  );

-- Down Migration

ALTER TABLE rfp_requests
  DROP CONSTRAINT IF EXISTS rfp_requests_reviewer_verdict_check;

ALTER TABLE rfp_requests
  DROP COLUMN IF EXISTS reviewer_source_message_ids,
  DROP COLUMN IF EXISTS reviewer_decided_at,
  DROP COLUMN IF EXISTS reviewer_id,
  DROP COLUMN IF EXISTS reviewer_rationale,
  DROP COLUMN IF EXISTS reviewer_verdict;
