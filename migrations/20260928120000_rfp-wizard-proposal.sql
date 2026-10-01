-- RFP intake: expected-user scale, AI intent, admin architecture, published proposal,
-- and requester approval (Apex - Apps repo + private Apex project)

-- Up Migration

ALTER TABLE rfp_requests
  ADD COLUMN IF NOT EXISTS expected_users TEXT,
  ADD COLUMN IF NOT EXISTS ai_in_app TEXT,
  ADD COLUMN IF NOT EXISTS architecture JSONB,
  ADD COLUMN IF NOT EXISTS proposal JSONB,
  ADD COLUMN IF NOT EXISTS approved_repo_name TEXT,
  ADD COLUMN IF NOT EXISTS approved_repo_url TEXT,
  ADD COLUMN IF NOT EXISTS apex_project TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE rfp_requests
  DROP CONSTRAINT IF EXISTS rfp_requests_expected_users_check,
  DROP CONSTRAINT IF EXISTS rfp_requests_ai_in_app_check;

ALTER TABLE rfp_requests
  ADD CONSTRAINT rfp_requests_expected_users_check CHECK (
    expected_users IS NULL OR expected_users IN ('small', 'medium', 'large')
  ),
  ADD CONSTRAINT rfp_requests_ai_in_app_check CHECK (
    ai_in_app IS NULL OR ai_in_app IN ('yes', 'no', 'not-sure')
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_rfp_requests_apex_project
  ON rfp_requests (lower(apex_project))
  WHERE apex_project IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_rfp_requests_apex_project;

ALTER TABLE rfp_requests
  DROP CONSTRAINT IF EXISTS rfp_requests_ai_in_app_check,
  DROP CONSTRAINT IF EXISTS rfp_requests_expected_users_check;

ALTER TABLE rfp_requests
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS apex_project,
  DROP COLUMN IF EXISTS approved_repo_url,
  DROP COLUMN IF EXISTS approved_repo_name,
  DROP COLUMN IF EXISTS proposal,
  DROP COLUMN IF EXISTS architecture,
  DROP COLUMN IF EXISTS ai_in_app,
  DROP COLUMN IF EXISTS expected_users;
