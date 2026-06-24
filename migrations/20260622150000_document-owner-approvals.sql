-- Up Migration
CREATE TABLE document_owner_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('prd', 'test_case', 'design_prototype')),
  owner_user_id text REFERENCES app_users(oid) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revision_requested')),
  comment text,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, document_type)
);

-- Down Migration
DROP TABLE IF EXISTS document_owner_approvals;
