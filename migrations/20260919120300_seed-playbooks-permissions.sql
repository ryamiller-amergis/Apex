-- Up Migration: playbooks:view and playbooks:run permission keys (TBI-011 / FEAT-003)
--
-- Three Epic 1 criteria gate on these two keys, so they are seeded here rather than waiting for
-- Epic 2's TBI-036, which creates playbooks:author and playbooks:admin. ON CONFLICT DO NOTHING means
-- that later migration will not collide on the two already present.
--
-- Granted to `admin` only. The PRD's target RBAC table eventually widens playbooks:view to member
-- and viewer and playbooks:run to member, but Phase 0 is a default-off internal spike behind the
-- playbooks-spike flag: least privilege now, widened deliberately when the feature is real.
-- Idempotent — safe to re-run.

INSERT INTO app_permissions (key, description, category)
VALUES
  ('playbooks:view', 'View Playbook definitions, runs and step status', 'playbooks'),
  ('playbooks:run',  'Start and cancel Playbook runs',                  'playbooks')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin'
  AND p.key IN ('playbooks:view', 'playbooks:run')
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM app_role_permissions
WHERE permission_id IN (
  SELECT id FROM app_permissions WHERE key IN ('playbooks:view', 'playbooks:run')
);

DELETE FROM app_permissions WHERE key IN ('playbooks:view', 'playbooks:run');
