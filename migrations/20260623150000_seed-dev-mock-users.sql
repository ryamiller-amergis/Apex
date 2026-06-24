-- Up Migration
-- Seeds local dev mock users with member role, project access, and group membership.

INSERT INTO app_users (oid, display_name, email, last_seen_at)
VALUES
  ('dev-mock-oid-00000000-0000-0000-0000-000000000000', 'Dev User', 'dev@localhost', NULL),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000001', 'BA Dev User', 'ba-dev@localhost', NULL),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000002', 'Manager Dev User', 'manager-dev@localhost', NULL),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000003', 'Product Owner Dev User', 'po-dev@localhost', NULL),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000004', 'QA Dev User', 'qa-dev@localhost', NULL),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000005', 'UI/UX Dev User', 'uiux-dev@localhost', NULL)
ON CONFLICT (oid) DO NOTHING;

INSERT INTO app_user_roles (user_id, role_id, assigned_by, assigned_at)
SELECT u.oid, r.id, 'dev-mock-seed', now()
FROM app_users u
CROSS JOIN app_roles r
WHERE u.oid LIKE 'dev-mock-oid-%'
  AND r.name = 'member'
ON CONFLICT DO NOTHING;

INSERT INTO user_project_assignments (id, user_id, project, assigned_by, assigned_at)
SELECT gen_random_uuid(), u.oid, p.project, 'dev-mock-seed', NOW()
FROM app_users u
CROSS JOIN (VALUES ('MaxView'), ('MatterWorx')) AS p(project)
WHERE u.oid LIKE 'dev-mock-oid-%'
ON CONFLICT (user_id, project) DO NOTHING;

INSERT INTO app_group_members (group_id, user_id, added_by, added_at)
SELECT g.id, m.user_id, 'dev-mock-seed', NOW()
FROM (VALUES
  ('dev-mock-oid-00000000-0000-0000-0000-000000000000', 'Developer'),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000001', 'BA'),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000002', 'Manager'),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000003', 'Product-Owner'),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000004', 'QA'),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000005', 'UI/UX')
) AS m(user_id, group_name)
INNER JOIN app_groups g ON g.name = m.group_name
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM app_group_members
WHERE added_by = 'dev-mock-seed';

DELETE FROM user_project_assignments
WHERE assigned_by = 'dev-mock-seed';

DELETE FROM app_user_roles
WHERE assigned_by = 'dev-mock-seed'
  AND user_id LIKE 'dev-mock-oid-%';

DELETE FROM app_users
WHERE oid LIKE 'dev-mock-oid-%';
