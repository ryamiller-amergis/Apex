-- Up Migration
-- quick-links:personal lets a user add, edit, delete, and import their own Quick Links
-- for a project they are assigned to. Admin and member by default; viewers stay read-only.
-- Idempotent — safe to re-run.

INSERT INTO app_permissions (key, description, category)
VALUES (
  'quick-links:personal',
  'Add, edit, delete, and import your own personal Quick Links for a project',
  'quick-links'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r
JOIN app_permissions p ON p.key = 'quick-links:personal'
WHERE r.name IN ('admin', 'member')
ON CONFLICT DO NOTHING;

-- Down Migration
-- Removes role links (including later grants on custom roles) and then the key.

DELETE FROM app_role_permissions
WHERE permission_id IN (
  SELECT id FROM app_permissions WHERE key = 'quick-links:personal'
);

DELETE FROM app_permissions WHERE key = 'quick-links:personal';
