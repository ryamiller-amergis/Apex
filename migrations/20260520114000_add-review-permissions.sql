-- Up Migration
INSERT INTO app_permissions (id, key, description, category) VALUES
  (gen_random_uuid(), 'prds:review', 'Approve or request revision on PRDs', 'prds'),
  (gen_random_uuid(), 'design-docs:review', 'Approve or request revision on design docs', 'design-docs');

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member')
  AND p.key IN ('prds:review', 'design-docs:review');

-- Down Migration
DELETE FROM app_permissions WHERE key IN ('prds:review', 'design-docs:review');
