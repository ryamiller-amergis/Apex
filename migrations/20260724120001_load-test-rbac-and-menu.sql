-- Up Migration: Load Test RBAC permissions (FEAT-003 / TBI-003)
-- Adds load-test:view, load-test:run, load-test:manage to the permission
-- catalog and seeds default role-permission mappings per the PRD:
--   viewer  → load-test:view
--   member  → load-test:view, load-test:run, load-test:manage
--   admin   → load-test:view, load-test:run, load-test:manage

INSERT INTO app_permissions (key, description, category)
VALUES
  ('load-test:view',   'View load-test definitions, runs, and results', 'load-test'),
  ('load-test:run',    'Enqueue and cancel load-test runs',             'load-test'),
  ('load-test:manage', 'Create, update, and delete load-test definitions', 'load-test')
ON CONFLICT (key) DO NOTHING;

-- viewer → load-test:view
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'viewer'
  AND p.key = 'load-test:view'
ON CONFLICT DO NOTHING;

-- member → load-test:view + load-test:run + load-test:manage
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'member'
  AND p.key IN ('load-test:view', 'load-test:run', 'load-test:manage')
ON CONFLICT DO NOTHING;

-- admin → all three (admin gets everything via the global seed, but be explicit
-- for correctness in environments where admin permissions are managed granularly)
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin'
  AND p.key IN ('load-test:view', 'load-test:run', 'load-test:manage')
ON CONFLICT DO NOTHING;

-- Down Migration
-- DELETE FROM app_permissions WHERE key IN ('load-test:view', 'load-test:run', 'load-test:manage');
