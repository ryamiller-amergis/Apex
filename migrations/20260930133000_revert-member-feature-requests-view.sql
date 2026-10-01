-- Apex Backlog view stays on the admin role.
-- Projects created in Apex grant this view in application code, not by changing member for every project.

DELETE FROM app_role_permissions
WHERE role_id = (SELECT id FROM app_roles WHERE name = 'member')
  AND permission_id = (SELECT id FROM app_permissions WHERE key = 'feature-requests:view');

-- Down Migration

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'member'
  AND p.key = 'feature-requests:view'
ON CONFLICT DO NOTHING;
