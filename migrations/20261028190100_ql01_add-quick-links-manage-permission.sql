-- Up Migration
-- quick-links:manage lets a user add, edit, reorder, and delete a project's Quick Links.
-- Admin role only by default. Reading links needs project access, not a permission.
-- Idempotent — safe to re-run.

INSERT INTO app_permissions (key, description, category)
VALUES (
  'quick-links:manage',
  'Add, edit, reorder, and delete the Quick Links shown for a project',
  'quick-links'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r
JOIN app_permissions p ON p.key = 'quick-links:manage'
WHERE r.name IN ('admin')
ON CONFLICT DO NOTHING;

-- Down Migration
-- Removes role links (including later grants on custom roles) and then the key.

DELETE FROM app_role_permissions
WHERE permission_id IN (
  SELECT id FROM app_permissions WHERE key = 'quick-links:manage'
);

DELETE FROM app_permissions WHERE key = 'quick-links:manage';
