-- Up Migration
-- skills:view reads project skills and reference-file names.
-- skills:approve-reference approves a reference file the person did not author.

INSERT INTO app_permissions (key, description, category)
VALUES
  ('skills:view', 'Read project skills, instruction files, and reference-file names', 'skills'),
  ('skills:approve-reference', 'Approve a reference file the person did not author', 'skills')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r
JOIN app_permissions p ON p.key IN ('skills:view', 'skills:approve-reference')
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r
JOIN app_permissions p ON p.key = 'skills:view'
WHERE r.name = 'member'
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM app_role_permissions
WHERE permission_id IN (
  SELECT id FROM app_permissions WHERE key IN ('skills:view', 'skills:approve-reference')
);

DELETE FROM app_permissions WHERE key IN ('skills:view', 'skills:approve-reference');
