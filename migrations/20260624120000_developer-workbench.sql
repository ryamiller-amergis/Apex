-- Add development skill settings to project_skill_settings
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS development_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS development_model TEXT;

-- Create dev_sessions table
CREATE TABLE IF NOT EXISTS dev_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id INTEGER NOT NULL,
  project TEXT NOT NULL,
  chat_thread_id UUID REFERENCES chat_threads(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  branch_name TEXT,
  status TEXT NOT NULL DEFAULT 'setting_up',
  setup_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dev_sessions_author ON dev_sessions(author_id);
CREATE INDEX IF NOT EXISTS idx_dev_sessions_thread ON dev_sessions(chat_thread_id);

-- Insert dev-workbench:view permission for admin and member roles
INSERT INTO app_permissions (key, category, description)
VALUES ('dev-workbench:view', 'dev-workbench', 'View Developer Workbench and start dev sessions')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member')
  AND p.key = 'dev-workbench:view'
ON CONFLICT DO NOTHING;
