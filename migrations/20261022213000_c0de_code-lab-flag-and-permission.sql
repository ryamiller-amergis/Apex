-- Up Migration: Code Lab feature flag and permission.
-- The flag is enabled with no targeting rules, so Code Lab stays hidden until a
-- super admin adds a user, project, or group rule in Platform Admin.
-- Cleanup: retain the enabled branch after two stable sprints at full rollout.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'code-lab',
  'Gates Code Lab: an AI agent edits a project checkout next to a sandboxed live preview.',
  true,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_permissions (key, description, category)
VALUES ('code-lab:use', 'Start Code Lab sessions, edit code with the agent, and push Code Lab branches', 'code-lab')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin'
  AND p.key = 'code-lab:use'
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM app_role_permissions
WHERE permission_id = (SELECT id FROM app_permissions WHERE key = 'code-lab:use');

DELETE FROM app_permissions WHERE key = 'code-lab:use';

DELETE FROM feature_flag_rules
WHERE flag_id = (SELECT id FROM feature_flags WHERE key = 'code-lab');

DELETE FROM feature_flags WHERE key = 'code-lab';
