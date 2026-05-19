ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS default_model TEXT;

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO app_settings (key, value) VALUES ('defaultModel', 'composer-2')
  ON CONFLICT DO NOTHING;
