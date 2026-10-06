-- Members of a project can open Apex Backlog when the project menu includes it.
-- admin already has feature-requests:view. This grant adds the member role only.

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'member'
  AND p.key = 'feature-requests:view'
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM app_role_permissions
WHERE role_id = (SELECT id FROM app_roles WHERE name = 'member')
  AND permission_id = (SELECT id FROM app_permissions WHERE key = 'feature-requests:view');
