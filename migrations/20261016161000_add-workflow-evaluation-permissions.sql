-- Up Migration
-- FEAT-002 / TBI-004: workflow-evaluation view and submit permissions.
-- Default grants go to the admin and member roles (not viewer).
-- Idempotent — safe to re-run.

INSERT INTO app_permissions (key, description, category)
VALUES
  (
    'workflow-evaluation:view',
    'View workflow evaluation definitions, event history and job diagnostics',
    'workflow-evaluation'
  ),
  (
    'workflow-evaluation:submit',
    'Submit human workflow evaluations on Interview phases and PRDs',
    'workflow-evaluation'
  )
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r
JOIN app_permissions p
  ON p.key IN ('workflow-evaluation:view', 'workflow-evaluation:submit')
WHERE r.name IN ('admin', 'member')
ON CONFLICT DO NOTHING;

-- Down Migration
-- Removes role links (including later grants on custom roles) and then only these two keys.

DELETE FROM app_role_permissions
WHERE permission_id IN (
  SELECT id FROM app_permissions
  WHERE key IN ('workflow-evaluation:view', 'workflow-evaluation:submit')
);

DELETE FROM app_permissions
WHERE key IN ('workflow-evaluation:view', 'workflow-evaluation:submit');
