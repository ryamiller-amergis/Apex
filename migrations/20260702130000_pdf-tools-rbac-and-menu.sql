-- ── PDF Tools: RBAC permission ───────────────────────────────────────────────
INSERT INTO app_permissions (key, description, category)
VALUES (
  'pdf-assembly:use',
  'Allows access to the PDF Tools assembly workspace',
  'pdf-tools'
)
ON CONFLICT (key) DO NOTHING;

-- pdf-assembly:use is assigned to no roles by default.
-- A Platform Admin must explicitly assign it to the appropriate role groups
-- after deployment before users can access PDF Tools.

-- Down Migration
-- DELETE FROM app_permissions WHERE key = 'pdf-assembly:use';
