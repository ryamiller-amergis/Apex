-- Up Migration

-- Remove obsolete Planning sub-tab RBAC permissions (planning:qa stays in use for QA Lab & test cases)
DELETE FROM app_permissions WHERE key IN ('planning:devstats', 'planning:ai-analysis');

-- Configurable per-project target platforms for generic release management
CREATE TABLE IF NOT EXISTS project_release_platforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'blue',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_project_release_platforms_project_slug UNIQUE (project, slug)
);

CREATE INDEX IF NOT EXISTS idx_project_release_platforms_project_sort
  ON project_release_platforms (project, sort_order);

CREATE TABLE IF NOT EXISTS release_epic_platforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  ado_epic_id INTEGER NOT NULL,
  platform_id UUID NOT NULL REFERENCES project_release_platforms(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_release_epic_platforms_scope UNIQUE (project, ado_epic_id, platform_id)
);

CREATE INDEX IF NOT EXISTS idx_release_epic_platforms_project
  ON release_epic_platforms (project, ado_epic_id);

CREATE TABLE IF NOT EXISTS release_work_item_platforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  work_item_id INTEGER NOT NULL,
  platform_id UUID NOT NULL REFERENCES project_release_platforms(id) ON DELETE CASCADE,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_release_work_item_platforms_scope UNIQUE (project, work_item_id, platform_id)
);

CREATE INDEX IF NOT EXISTS idx_release_work_item_platforms_project
  ON release_work_item_platforms (project, work_item_id);

-- Down Migration

DROP TABLE IF EXISTS release_work_item_platforms;
DROP TABLE IF EXISTS release_epic_platforms;
DROP TABLE IF EXISTS project_release_platforms;

INSERT INTO app_permissions (id, key, description, category) VALUES
  (gen_random_uuid(), 'planning:devstats',    'View Developer Stats tab', 'planning'),
  (gen_random_uuid(), 'planning:ai-analysis', 'View AI Analysis tab',     'planning')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member')
  AND p.key IN ('planning:devstats', 'planning:ai-analysis')
ON CONFLICT DO NOTHING;
