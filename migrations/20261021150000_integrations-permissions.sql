-- Up Migration
-- Integrations permissions are project-assigned. No default role receives them.

INSERT INTO app_permissions (key, description, category)
VALUES
  ('integrations:view', 'Open Integrations and ask through an allowed connection', 'integrations'),
  ('integrations:manage', 'Create, test, edit access, and remove integration connections', 'integrations')
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM app_permissions WHERE key IN ('integrations:view', 'integrations:manage');
