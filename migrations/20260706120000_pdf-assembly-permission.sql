-- Up Migration
-- Add pdf-assembly:use permission to the RBAC catalog
INSERT INTO app_permissions (id, key, description, category) VALUES
  (gen_random_uuid(), 'pdf-assembly:use', 'Allows access to the PDF Tools assembly workspace', 'pdf-tools');

-- Assign to admin and member roles
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member') AND p.key = 'pdf-assembly:use';

-- Down Migration
DELETE FROM app_permissions WHERE key = 'pdf-assembly:use';
