-- Up Migration: Work Board RBAC permissions

INSERT INTO app_permissions (key, description, category)
VALUES
  ('work-board:view', 'View the Work Board and work items', 'work-board'),
  ('work-board:manage', 'Create, edit, move, and assign Work Board items', 'work-board'),
  ('work-board:admin', 'Administer Work Board settings and bulk operations', 'work-board')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member', 'viewer')
  AND p.key = 'work-board:view'
ON CONFLICT DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member')
  AND p.key IN ('work-board:manage', 'work-board:admin')
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM app_permissions
WHERE key IN ('work-board:view', 'work-board:manage', 'work-board:admin');
