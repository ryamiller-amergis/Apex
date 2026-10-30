-- Up Migration
-- FEAT-001 / TBI-002: Brainstorm view and create permissions.
-- Both go to admin, member and viewer. Ownership, not role, limits who may change a session.
-- Idempotent — safe to re-run.

INSERT INTO app_permissions (key, description, category)
VALUES
  (
    'brainstorm:view',
    'Open the Brainstorm list and read sessions in projects you are assigned to',
    'brainstorm'
  ),
  (
    'brainstorm:create',
    'Start Brainstorm sessions and chat in sessions you created',
    'brainstorm'
  )
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r
JOIN app_permissions p ON p.key IN ('brainstorm:view', 'brainstorm:create')
WHERE r.name IN ('admin', 'member', 'viewer')
ON CONFLICT DO NOTHING;

-- Down Migration
-- Removes role links (including later grants on custom roles) and then only these two keys.

DELETE FROM app_role_permissions
WHERE permission_id IN (
  SELECT id FROM app_permissions
  WHERE key IN ('brainstorm:view', 'brainstorm:create')
);

DELETE FROM app_permissions
WHERE key IN ('brainstorm:view', 'brainstorm:create');
