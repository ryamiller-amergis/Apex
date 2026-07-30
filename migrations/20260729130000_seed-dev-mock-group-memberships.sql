-- Up Migration
-- The dev-mock-users seed (20260623) silently no-ops for group memberships when
-- the app_groups rows haven't been created yet (groups are seeded per-project by
-- 20260610 only AFTER project_skill_settings rows exist, which happens via the UI).
-- This migration ensures global (project-agnostic) groups exist for the canonical
-- dev personas and then assigns each dev-mock user to its group.

-- 1. Ensure the canonical dev persona groups exist as global (project = NULL) groups.
INSERT INTO app_groups (name, description, project, is_default)
VALUES
  ('Developer',      'Software development and engineering', NULL, true),
  ('BA',             'Business analysis and requirements',   NULL, true),
  ('Manager',        'Project and team management',          NULL, true),
  ('Product-Owner',  'Product ownership and strategy',       NULL, true),
  ('QA',             'Quality assurance and test case review', NULL, true),
  ('UI/UX',          'User interface and experience design', NULL, true)
ON CONFLICT DO NOTHING;

-- 2. Re-run the dev-mock group membership inserts now that the global groups exist.
INSERT INTO app_group_members (group_id, user_id, added_by, added_at)
SELECT g.id, m.user_id, 'dev-mock-seed', now()
FROM (VALUES
  ('dev-mock-oid-00000000-0000-0000-0000-000000000000', 'Developer'),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000001', 'BA'),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000002', 'Manager'),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000003', 'Product-Owner'),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000004', 'QA'),
  ('dev-mock-oid-00000000-0000-0000-0000-000000000005', 'UI/UX')
) AS m(user_id, group_name)
INNER JOIN app_groups g ON g.name = m.group_name AND g.project IS NULL
INNER JOIN app_users  u ON u.oid = m.user_id
ON CONFLICT DO NOTHING;

-- Down Migration
-- DELETE FROM app_group_members WHERE added_by = 'dev-mock-seed';
-- DELETE FROM app_groups WHERE is_default = true AND project IS NULL;
