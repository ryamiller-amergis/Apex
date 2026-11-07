-- Up Migration
-- Personal Quick Links: visible only to their owner, and only while that project is selected.
-- url holds the normalized URL, so the unique key also stops a bookmark re-import from duplicating links.

CREATE TABLE IF NOT EXISTS user_quick_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  project TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_quick_links_label_not_blank CHECK (length(btrim(label)) > 0),
  CONSTRAINT user_quick_links_url_http CHECK (url ~* '^https?://'),
  CONSTRAINT user_quick_links_user_project_url_key UNIQUE (user_id, project, url)
);

CREATE INDEX IF NOT EXISTS idx_user_quick_links_user_project ON user_quick_links (user_id, project);

-- Down Migration
DROP INDEX IF EXISTS idx_user_quick_links_user_project;
DROP TABLE IF EXISTS user_quick_links;
