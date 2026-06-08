-- Up Migration
-- Add granular per-sub-tab permissions for the Planning section.
-- These let admins control which roles can access each Planning sub-page.
INSERT INTO app_permissions (id, key, description, category) VALUES
  (gen_random_uuid(), 'planning:devstats',    'View Developer Stats tab',  'planning'),
  (gen_random_uuid(), 'planning:qa',          'View QA Metrics tab',       'planning'),
  (gen_random_uuid(), 'planning:ai-analysis', 'View AI Analysis tab',      'planning'),
  (gen_random_uuid(), 'planning:roadmap',     'View Roadmap tab',          'planning'),
  (gen_random_uuid(), 'planning:releases',    'View Releases tab',         'planning');

-- admin gets all sub-tab permissions
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin'
  AND p.key IN ('planning:devstats','planning:qa','planning:ai-analysis','planning:roadmap','planning:releases');

-- member gets all sub-tab permissions
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'member'
  AND p.key IN ('planning:devstats','planning:qa','planning:ai-analysis','planning:roadmap','planning:releases');

-- viewer gets no planning sub-tab permissions by default
-- (they have planning:view to reach the section, but no tabs will be visible)

-- Down Migration
DELETE FROM app_permissions
WHERE key IN ('planning:devstats','planning:qa','planning:ai-analysis','planning:roadmap','planning:releases');
