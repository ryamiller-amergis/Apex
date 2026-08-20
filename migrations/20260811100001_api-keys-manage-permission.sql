-- Up Migration: api-keys:manage permission (FEAT-001 / TBI-002)
-- New api-keys category; assigned to admin role by default.

INSERT INTO app_permissions (key, description, category)
VALUES
  ('api-keys:manage', 'Create, view, update, regenerate, and delete project API keys', 'api-keys')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin'
  AND p.key = 'api-keys:manage'
ON CONFLICT DO NOTHING;

-- Down Migration
-- DELETE FROM app_permissions WHERE key = 'api-keys:manage';
