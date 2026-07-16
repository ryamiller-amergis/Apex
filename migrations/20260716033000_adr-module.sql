CREATE TABLE IF NOT EXISTS adrs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_thread_id UUID NOT NULL UNIQUE REFERENCES chat_threads(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Untitled ADR',
  project TEXT NOT NULL,
  repo TEXT NOT NULL,
  model TEXT,
  skill_settings_id UUID REFERENCES project_skill_settings(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  content TEXT NOT NULL DEFAULT '',
  slug TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adrs_project_updated ON adrs(project, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_adrs_author_updated ON adrs(author_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_adrs_status ON adrs(status);

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS adr_interview_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS adr_finalize_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS adr_model TEXT;

INSERT INTO app_permissions (key, category, description)
VALUES
  ('adr:view', 'adr', 'View architecture decision records'),
  ('adr:create', 'adr', 'Create architecture decision records'),
  ('adr:edit', 'adr', 'Edit architecture decision records'),
  ('adr:delete', 'adr', 'Delete architecture decision records')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member', 'viewer')
  AND p.key = 'adr:view'
ON CONFLICT DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member')
  AND p.key IN ('adr:create', 'adr:edit', 'adr:delete')
ON CONFLICT DO NOTHING;
