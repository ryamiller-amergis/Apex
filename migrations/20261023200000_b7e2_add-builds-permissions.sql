-- Up Migration
-- FEAT-002 / TBI-004: Build from Prompt view and run permissions.
-- builds:view goes to admin, member and viewer. builds:run goes to admin and member.
-- Idempotent — safe to re-run.

INSERT INTO app_permissions (key, description, category)
VALUES
  (
    'builds:view',
    'View builds, their events and evidence in projects you are assigned to',
    'builds'
  ),
  (
    'builds:run',
    'Start builds on approved project and repository pairs',
    'builds'
  )
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r
JOIN app_permissions p ON p.key = 'builds:view'
WHERE r.name IN ('admin', 'member', 'viewer')
ON CONFLICT DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r
JOIN app_permissions p ON p.key = 'builds:run'
WHERE r.name IN ('admin', 'member')
ON CONFLICT DO NOTHING;

-- Down Migration
-- Removes role links (including later grants on custom roles) and then only these two keys.

DELETE FROM app_role_permissions
WHERE permission_id IN (
  SELECT id FROM app_permissions
  WHERE key IN ('builds:view', 'builds:run')
);

DELETE FROM app_permissions
WHERE key IN ('builds:view', 'builds:run');
