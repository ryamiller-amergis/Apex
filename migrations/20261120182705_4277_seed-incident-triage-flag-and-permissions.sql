-- Up Migration
--
-- ServiceNow incident triage: reads MaxView incidents, runs an AI analysis on each
-- change, and posts a Teams card. Off hides the page, stops the sweep and the posts.
-- Winning branch: enabled. Cleanup criterion: retire after two stable sprints
-- at full rollout.
-- Permissions: view goes to admin and member; run and manage go to admin.
-- Idempotent — safe to re-run.

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'servicenow-incident-triage',
  'Gates ServiceNow incident triage: the scheduled and on-demand sweep, AI analysis of each incident, the Incident Triage page, and Teams posts. Off hides the page and stops the sweep and posts. Winning branch: enabled. Cleanup criterion: retire after two stable sprints at full rollout.',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_permissions (key, description, category)
VALUES
  (
    'incident-triage:view',
    'Open Incident Triage and read analyzed ServiceNow incidents in projects you are assigned to',
    'incident-triage'
  ),
  (
    'incident-triage:run',
    'Check ServiceNow now and re-analyze incidents',
    'incident-triage'
  ),
  (
    'incident-triage:manage',
    'Edit Incident Triage settings, assignment groups and the Teams webhook',
    'incident-triage'
  )
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r
JOIN app_permissions p ON p.key = 'incident-triage:view'
WHERE r.name IN ('admin', 'member')
ON CONFLICT DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r
JOIN app_permissions p ON p.key IN ('incident-triage:run', 'incident-triage:manage')
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- Down Migration
-- Removes role links (including later grants on custom roles), the three keys, then the flag.

DELETE FROM app_role_permissions
WHERE permission_id IN (
  SELECT id FROM app_permissions
  WHERE key IN ('incident-triage:view', 'incident-triage:run', 'incident-triage:manage')
);

DELETE FROM app_permissions
WHERE key IN ('incident-triage:view', 'incident-triage:run', 'incident-triage:manage');

DELETE FROM feature_flag_rules
WHERE flag_id = (
  SELECT id FROM feature_flags WHERE key = 'servicenow-incident-triage'
);

DELETE FROM feature_flags
WHERE key = 'servicenow-incident-triage';
