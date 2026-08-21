-- Up Migration

INSERT INTO app_permissions (key, category, description)
VALUES
  (
    'rfp-intake:submit',
    'rfp-intake',
    'Submit a Request for Product and view own submissions'
  )
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin'
  AND p.key = 'rfp-intake:submit'
ON CONFLICT DO NOTHING;

INSERT INTO app_roles (name, description, is_default)
VALUES ('rfp-submitter', 'Submit Requests for Product after Apex approval', false)
ON CONFLICT (name) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'rfp-submitter'
  AND p.key = 'rfp-intake:submit'
ON CONFLICT DO NOTHING;

CREATE TABLE rfp_intake_submit_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT
);

CREATE INDEX idx_rfp_intake_submit_requests_user_id ON rfp_intake_submit_requests(user_id);
CREATE INDEX idx_rfp_intake_submit_requests_status ON rfp_intake_submit_requests(status);
CREATE UNIQUE INDEX idx_rfp_intake_submit_requests_pending_unique
  ON rfp_intake_submit_requests(user_id)
  WHERE status = 'pending';

-- Down Migration

DROP TABLE IF EXISTS rfp_intake_submit_requests;

DELETE FROM app_roles WHERE name = 'rfp-submitter';
DELETE FROM app_permissions WHERE key = 'rfp-intake:submit';
