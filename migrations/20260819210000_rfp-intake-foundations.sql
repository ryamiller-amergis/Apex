-- RFP Intake foundations: five-table persistence, skill settings, and RBAC keys
-- FEAT-001 / TBI-001

-- Up Migration

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS product_intake_evaluation_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS product_intake_evaluation_model TEXT;

CREATE TABLE rfp_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  title TEXT NOT NULL,
  stakeholder TEXT NOT NULL,
  request TEXT NOT NULL,
  problem TEXT NOT NULL,
  audience TEXT NOT NULL,
  data_sensitivity TEXT NOT NULL,
  existing_solution TEXT NOT NULL,
  advantage TEXT,
  constraints TEXT,
  request_type TEXT,
  existing_system_stack TEXT,
  status TEXT NOT NULL DEFAULT 'evaluating',
  ai_status TEXT NOT NULL DEFAULT 'evaluating',
  ai_thread_id TEXT,
  source_project TEXT NOT NULL,
  current_evaluation_id UUID,
  clarification_used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rfp_requests_status_check CHECK (
    status IN ('submitted', 'evaluating', 'evaluated', 'in-review', 'accepted', 'declined', 'on-hold')
  ),
  CONSTRAINT rfp_requests_ai_status_check CHECK (
    ai_status IN ('evaluating', 'failed', 'complete')
  ),
  CONSTRAINT rfp_requests_audience_check CHECK (
    audience IN ('internal', 'external', 'mixed')
  )
);

CREATE INDEX idx_rfp_requests_owner_created
  ON rfp_requests (owner_id, created_at DESC);

CREATE INDEX idx_rfp_requests_status_created
  ON rfp_requests (status, created_at DESC);

CREATE INDEX idx_rfp_requests_ai_status
  ON rfp_requests (ai_status);

CREATE TABLE rfp_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_request_id UUID NOT NULL REFERENCES rfp_requests(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  confidence TEXT NOT NULL,
  tech_velocity TEXT NOT NULL,
  native_benefit TEXT NOT NULL,
  audience TEXT NOT NULL,
  data_leaves_tenant BOOLEAN NOT NULL,
  priority TEXT NOT NULL,
  risk TEXT NOT NULL,
  delivery_approach TEXT NOT NULL,
  recommended_lane TEXT NOT NULL,
  recommended_tooling JSONB NOT NULL DEFAULT '[]'::jsonb,
  hosting_recommendation TEXT NOT NULL,
  operational_owner TEXT NOT NULL,
  reuse_opportunity TEXT NOT NULL,
  enters_interview_flow BOOLEAN NOT NULL,
  build_buy_rent_summary TEXT NOT NULL,
  rationale TEXT NOT NULL,
  existing_overlap TEXT NOT NULL,
  clarifying_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_output JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rfp_evaluations_request_version_key UNIQUE (rfp_request_id, version),
  CONSTRAINT rfp_evaluations_version_positive CHECK (version >= 1),
  CONSTRAINT rfp_evaluations_verdict_check CHECK (
    verdict IN ('build', 'rent-and-wrap', 'rent', 'buy', 'decline', 'needs-clarification')
  ),
  CONSTRAINT rfp_evaluations_confidence_check CHECK (
    confidence IN ('low', 'medium', 'high')
  ),
  CONSTRAINT rfp_evaluations_tech_velocity_check CHECK (
    tech_velocity IN ('stable', 'moderate', 'frontier')
  ),
  CONSTRAINT rfp_evaluations_native_benefit_check CHECK (
    native_benefit IN ('low', 'medium', 'high')
  )
);

CREATE INDEX idx_rfp_evaluations_request_id
  ON rfp_evaluations (rfp_request_id);

CREATE INDEX idx_rfp_evaluations_verdict
  ON rfp_evaluations (verdict);

ALTER TABLE rfp_requests
  ADD CONSTRAINT rfp_requests_current_evaluation_id_fkey
  FOREIGN KEY (current_evaluation_id) REFERENCES rfp_evaluations(id) ON DELETE SET NULL;

CREATE TABLE rfp_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_request_id UUID NOT NULL REFERENCES rfp_requests(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  body TEXT NOT NULL,
  mentioned_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rfp_comments_request_created
  ON rfp_comments (rfp_request_id, created_at);

CREATE TABLE rfp_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_request_id UUID NOT NULL REFERENCES rfp_requests(id) ON DELETE CASCADE,
  comment_id UUID REFERENCES rfp_comments(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rfp_attachments_size_bytes_check CHECK (size_bytes >= 0)
);

CREATE INDEX idx_rfp_attachments_request_id
  ON rfp_attachments (rfp_request_id);

CREATE INDEX idx_rfp_attachments_comment_id
  ON rfp_attachments (comment_id);

CREATE TABLE rfp_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_request_id UUID NOT NULL REFERENCES rfp_requests(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rfp_request_events_request_created
  ON rfp_request_events (rfp_request_id, created_at);

INSERT INTO app_permissions (key, category, description)
VALUES
  ('rfp-intake:view', 'rfp-intake', 'View the Apex RFP Intake queue and request detail'),
  ('rfp-intake:manage', 'rfp-intake', 'Change RFP status, reopen, retry, or request re-evaluation')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin'
  AND p.key IN ('rfp-intake:view', 'rfp-intake:manage')
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM app_role_permissions
WHERE permission_id IN (
  SELECT id FROM app_permissions WHERE key IN ('rfp-intake:view', 'rfp-intake:manage')
);

DELETE FROM app_permissions WHERE key IN ('rfp-intake:view', 'rfp-intake:manage');

ALTER TABLE rfp_requests DROP CONSTRAINT IF EXISTS rfp_requests_current_evaluation_id_fkey;

DROP TABLE IF EXISTS rfp_request_events;
DROP TABLE IF EXISTS rfp_attachments;
DROP TABLE IF EXISTS rfp_comments;
DROP TABLE IF EXISTS rfp_evaluations;
DROP TABLE IF EXISTS rfp_requests;

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS product_intake_evaluation_model,
  DROP COLUMN IF EXISTS product_intake_evaluation_skill_path;
