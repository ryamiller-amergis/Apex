-- Up Migration

-- New table: document_approver_assignments
CREATE TABLE IF NOT EXISTS document_approver_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('prd', 'design_doc')),
  approver_user_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revision_requested')),
  comment TEXT,
  responded_at TIMESTAMPTZ,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by TEXT NOT NULL,
  UNIQUE (document_id, document_type, approver_user_id)
);

CREATE INDEX idx_daa_document ON document_approver_assignments (document_id, document_type);
CREATE INDEX idx_daa_approver_status ON document_approver_assignments (approver_user_id, status);

-- Add approval_mode to project_skill_settings
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS approval_mode TEXT NOT NULL DEFAULT 'any_one' CHECK (approval_mode IN ('any_one', 'all_required'));

-- Add design_doc_approver_ids to prds
ALTER TABLE prds ADD COLUMN IF NOT EXISTS design_doc_approver_ids JSONB DEFAULT NULL;

-- Down Migration

-- ALTER TABLE prds DROP COLUMN IF EXISTS design_doc_approver_ids;
-- ALTER TABLE project_skill_settings DROP COLUMN IF EXISTS approval_mode;
-- DROP INDEX IF EXISTS idx_daa_approver_status;
-- DROP INDEX IF EXISTS idx_daa_document;
-- DROP TABLE IF EXISTS document_approver_assignments;
