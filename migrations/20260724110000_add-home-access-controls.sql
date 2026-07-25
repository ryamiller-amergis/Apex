-- Up Migration: Add home:view permission and agent-home feature flag.
-- Both controls are required for Home access; seeded with full access
-- for all existing roles and an "everyone" flag rule so current behaviour
-- is preserved by default.  Idempotent — safe to re-run.

-- 1. home:view permission
INSERT INTO app_permissions (id, key, description, category)
VALUES (gen_random_uuid(), 'home:view', 'Access the Agent Home page', 'chat')
ON CONFLICT (key) DO NOTHING;

-- Grant home:view to admin, member, and viewer roles
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member', 'viewer')
  AND p.key = 'home:view'
  AND NOT EXISTS (
    SELECT 1 FROM app_role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- 2. agent-home feature flag (enabled, everyone rule)
INSERT INTO feature_flags (key, description, enabled, lifecycle, cleanup_ready, created_by)
VALUES (
  'agent-home',
  'Controls access to the Agent Home page; acts as a kill switch even when home:view is granted',
  true,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO feature_flag_rules (flag_id, type, value, created_by)
SELECT f.id, 'everyone', NULL, NULL
FROM feature_flags f
WHERE f.key = 'agent-home'
  AND NOT EXISTS (
    SELECT 1 FROM feature_flag_rules r
    WHERE r.flag_id = f.id AND r.type = 'everyone'
  );

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (SELECT id FROM feature_flags WHERE key = 'agent-home')
  AND type = 'everyone';

DELETE FROM feature_flags WHERE key = 'agent-home';

DELETE FROM app_role_permissions
WHERE permission_id = (SELECT id FROM app_permissions WHERE key = 'home:view');

DELETE FROM app_permissions WHERE key = 'home:view';
