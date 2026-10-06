-- Product builds: one initial build per approved RFP, plus later changes.
-- PRODUCT.md stays the broad product context. The brief JSON is the slice
-- for one pull request. Agent run id is text with no foreign key so a later
-- link from agent_runs back to this table cannot cycle.

-- Up Migration

CREATE TABLE IF NOT EXISTS product_builds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovery',
  project TEXT NOT NULL,
  rfp_request_id UUID REFERENCES rfp_requests(id) ON DELETE SET NULL,
  chat_thread_id UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
  ui_lab_design_id UUID REFERENCES ui_lab_designs(id) ON DELETE SET NULL,
  dev_session_id UUID REFERENCES dev_sessions(id) ON DELETE SET NULL,
  agent_run_id TEXT,
  brief JSONB,
  prototype_version INTEGER,
  requester_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  reviewer_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  ado_work_item_id INTEGER,
  pr_url TEXT,
  error_message TEXT,
  approved_at TIMESTAMPTZ,
  pr_opened_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_builds_kind_check CHECK (
    kind IN ('initial', 'feature', 'bug', 'refinement')
  ),
  CONSTRAINT product_builds_status_check CHECK (
    status IN (
      'discovery',
      'brief-confirmed',
      'prototype',
      'approved',
      'building',
      'pr-open',
      'failed'
    )
  ),
  CONSTRAINT product_builds_brief_check CHECK (
    brief IS NULL OR jsonb_typeof(brief) = 'object'
  ),
  CONSTRAINT product_builds_prototype_version_check CHECK (
    prototype_version IS NULL OR prototype_version >= 1
  ),
  CONSTRAINT product_builds_ado_work_item_check CHECK (
    ado_work_item_id IS NULL OR ado_work_item_id > 0
  )
);

-- One initial build for each RFP. Later feature, bug, and refinement rows are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_builds_one_initial_per_rfp
  ON product_builds (rfp_request_id)
  WHERE kind = 'initial' AND rfp_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_builds_project_status
  ON product_builds (project, status);

CREATE INDEX IF NOT EXISTS idx_product_builds_requester_created
  ON product_builds (requester_id, created_at);

CREATE INDEX IF NOT EXISTS idx_product_builds_rfp
  ON product_builds (rfp_request_id)
  WHERE rfp_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_builds_chat_thread
  ON product_builds (chat_thread_id)
  WHERE chat_thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_builds_agent_run
  ON product_builds (agent_run_id)
  WHERE agent_run_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_product_builds_agent_run;
DROP INDEX IF EXISTS idx_product_builds_chat_thread;
DROP INDEX IF EXISTS idx_product_builds_rfp;
DROP INDEX IF EXISTS idx_product_builds_requester_created;
DROP INDEX IF EXISTS idx_product_builds_project_status;
DROP INDEX IF EXISTS idx_product_builds_one_initial_per_rfp;
DROP TABLE IF EXISTS product_builds;
