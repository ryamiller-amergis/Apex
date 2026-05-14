-- Up Migration
-- Seeds the bootstrap admin user and assigns the admin role.
-- This runs automatically in all environments (local, CI, production).

INSERT INTO app_users (oid, display_name, email, last_seen_at)
VALUES ('110b196f-3f0d-4890-969f-5571085039de', 'Ryan Miller', '', NULL)
ON CONFLICT (oid) DO NOTHING;

INSERT INTO app_user_roles (user_id, role_id, assigned_by, assigned_at)
SELECT
  '110b196f-3f0d-4890-969f-5571085039de',
  r.id,
  'migration',
  now()
FROM app_roles r
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM app_user_roles
WHERE user_id = '110b196f-3f0d-4890-969f-5571085039de';

DELETE FROM app_users
WHERE oid = '110b196f-3f0d-4890-969f-5571085039de';
