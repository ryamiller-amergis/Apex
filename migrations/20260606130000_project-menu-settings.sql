CREATE TABLE IF NOT EXISTS project_menu_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT UNIQUE NOT NULL,
  enabled_views JSONB NOT NULL DEFAULT '[]',
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
