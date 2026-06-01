-- Up Migration
INSERT INTO app_permissions (id, key, description, category) VALUES
  (gen_random_uuid(), 'notifications:view', 'View and receive notifications', 'notifications');

-- admin gets notifications:view
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM app_roles r, app_permissions p
WHERE r.name = 'admin' AND p.key = 'notifications:view';

-- member gets notifications:view
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM app_roles r, app_permissions p
WHERE r.name = 'member' AND p.key = 'notifications:view';

-- Down Migration
DELETE FROM app_permissions WHERE key = 'notifications:view';
