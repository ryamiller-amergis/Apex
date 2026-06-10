-- Up Migration

ALTER TABLE app_groups ADD COLUMN IF NOT EXISTS project TEXT;
ALTER TABLE app_groups ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE app_groups DROP CONSTRAINT IF EXISTS app_groups_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_groups_name_project
  ON app_groups (name, COALESCE(project, ''));

INSERT INTO app_groups (name, description, project, is_default)
SELECT g.name, g.description, p.project, true
FROM project_skill_settings p
CROSS JOIN (VALUES
  ('Product-Owner', 'Product ownership and strategy'),
  ('BA', 'Business analysis and requirements'),
  ('UI/UX', 'User interface and experience design'),
  ('Manager', 'Project and team management'),
  ('Developer', 'Software development and engineering')
) AS g(name, description)
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM app_groups WHERE is_default = true;

DROP INDEX IF EXISTS uniq_app_groups_name_project;

ALTER TABLE app_groups ADD CONSTRAINT app_groups_name_key UNIQUE (name);

ALTER TABLE app_groups DROP COLUMN IF EXISTS is_default;
ALTER TABLE app_groups DROP COLUMN IF EXISTS project;
