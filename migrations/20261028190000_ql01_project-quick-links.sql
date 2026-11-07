-- Up Migration
-- Per-project Quick Links shown in the app header. `project` holds the same
-- project name as project_skill_settings.project. Links live in their own table
-- because they belong to the project, not to a repo config.

CREATE TABLE IF NOT EXISTS project_quick_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_quick_links_label_not_blank CHECK (length(btrim(label)) > 0),
  CONSTRAINT project_quick_links_url_http CHECK (url ~* '^https?://')
);

CREATE INDEX IF NOT EXISTS idx_project_quick_links_project ON project_quick_links (project);

-- Down Migration
DROP INDEX IF EXISTS idx_project_quick_links_project;
DROP TABLE IF EXISTS project_quick_links;
