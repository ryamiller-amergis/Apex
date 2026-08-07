-- Up Migration: FEAT-001 Diagram persistence and authorized RBAC prerequisites

CREATE TABLE diagrams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  scene JSONB NOT NULL,
  thumbnail TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT diagrams_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT diagrams_version_positive CHECK (version > 0)
);

CREATE INDEX idx_diagrams_project_owner ON diagrams (project_id, owner_id);
CREATE INDEX idx_diagrams_project_updated ON diagrams (project_id, updated_at DESC);

CREATE TABLE diagram_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id UUID NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  grantee_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  access TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT diagram_shares_diagram_id_grantee_id_key UNIQUE (diagram_id, grantee_id),
  CONSTRAINT diagram_shares_access_check CHECK (access IN ('view', 'edit'))
);

CREATE INDEX idx_diagram_shares_grantee ON diagram_shares (grantee_id, diagram_id);

INSERT INTO app_permissions (key, description, category)
VALUES
  ('diagram:view', 'View owned and shared Diagrams', 'diagram'),
  ('diagram:create', 'Create Diagrams', 'diagram'),
  ('diagram:edit', 'Edit owned or editable shared Diagrams', 'diagram'),
  ('diagram:delete', 'Delete owned Diagrams', 'diagram'),
  ('diagram:share', 'Manage shares for owned Diagrams', 'diagram')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member', 'viewer')
  AND p.key = 'diagram:view'
ON CONFLICT DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member')
  AND p.key IN ('diagram:create', 'diagram:edit', 'diagram:delete', 'diagram:share')
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM app_permissions
WHERE key IN (
  'diagram:view',
  'diagram:create',
  'diagram:edit',
  'diagram:delete',
  'diagram:share'
);

DROP TABLE IF EXISTS diagram_shares;
DROP TABLE IF EXISTS diagrams;
