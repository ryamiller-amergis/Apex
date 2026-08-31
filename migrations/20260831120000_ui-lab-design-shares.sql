-- Up Migration: UI Lab named-user view-only sharing

CREATE TABLE ui_lab_design_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id UUID NOT NULL REFERENCES ui_lab_designs(id) ON DELETE CASCADE,
  grantee_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ui_lab_design_shares_design_id_grantee_id_key UNIQUE (design_id, grantee_id)
);

CREATE INDEX idx_ui_lab_design_shares_grantee ON ui_lab_design_shares (grantee_id, design_id);
CREATE INDEX idx_ui_lab_design_shares_design ON ui_lab_design_shares (design_id, created_at);

-- Down Migration

DROP TABLE IF EXISTS ui_lab_design_shares;
