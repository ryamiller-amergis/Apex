-- Seed RBAC permissions for feature requests

INSERT INTO app_permissions (key, category, description)
VALUES
  ('feature-requests:submit', 'feature-requests', 'Submit feature requests'),
  ('feature-requests:view', 'feature-requests', 'View all feature requests'),
  ('feature-requests:manage', 'feature-requests', 'Manage and triage feature requests')
ON CONFLICT (key) DO NOTHING;

-- admin + member can submit
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member')
  AND p.key = 'feature-requests:submit'
ON CONFLICT DO NOTHING;

-- admin can view
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin'
  AND p.key = 'feature-requests:view'
ON CONFLICT DO NOTHING;

-- admin can manage
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin'
  AND p.key = 'feature-requests:manage'
ON CONFLICT DO NOTHING;
