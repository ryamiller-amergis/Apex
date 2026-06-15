-- Up Migration

INSERT INTO user_project_assignments (id, user_id, project, assigned_by, assigned_at)
SELECT
  gen_random_uuid(),
  u.oid,
  p.project,
  'system-migration',
  NOW()
FROM app_users u
CROSS JOIN (VALUES ('MaxView'), ('MatterWorx')) AS p(project)
WHERE u.oid <> 'dev-mock-oid-00000000-0000-0000-0000-000000000000'
  AND LOWER(COALESCE(u.email, '')) <> 'dev@localhost'
ON CONFLICT (user_id, project) DO NOTHING;

-- Down Migration

DELETE FROM user_project_assignments
WHERE assigned_by = 'system-migration';
