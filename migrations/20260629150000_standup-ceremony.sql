-- Standup Ceremony tables

CREATE TABLE IF NOT EXISTS standup_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES app_groups(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  area_path TEXT,
  iteration_mode TEXT NOT NULL DEFAULT 'current',
  iteration_path TEXT,
  schedule_time TEXT NOT NULL DEFAULT '09:00',
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  weekdays JSONB NOT NULL DEFAULT '[1,2,3,4,5]',
  skill_settings_id UUID REFERENCES project_skill_settings(id) ON DELETE SET NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_standup_configs_group ON standup_configs(group_id);
CREATE INDEX IF NOT EXISTS idx_standup_configs_enabled ON standup_configs(enabled);

CREATE TABLE IF NOT EXISTS standup_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL REFERENCES standup_configs(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES app_groups(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  facilitator_thread_id UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
  summary_markdown TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_standup_sessions_config ON standup_sessions(config_id);
CREATE INDEX IF NOT EXISTS idx_standup_sessions_date ON standup_sessions(session_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_standup_sessions_config_date ON standup_sessions(config_id, session_date);

CREATE TABLE IF NOT EXISTS standup_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES standup_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  thread_id UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  structured_update JSONB,
  ado_access_token TEXT,
  ado_token_expires_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_standup_participants_session ON standup_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_standup_participants_user ON standup_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_standup_participants_thread ON standup_participants(thread_id);

CREATE TABLE IF NOT EXISTS standup_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES standup_sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  participant_user_ids JSONB NOT NULL DEFAULT '[]',
  related_work_item_ids JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  followup_thread_id UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_standup_followups_session ON standup_followups(session_id);

-- Add standup_skill_path column to project_skill_settings
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS standup_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS standup_model TEXT;

-- Permissions
INSERT INTO app_permissions (key, category, description)
VALUES
  ('standup:participate', 'standup', 'Participate in standup ceremonies'),
  ('standup:manage', 'standup', 'Manage standup configurations and trigger facilitator')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member')
  AND p.key = 'standup:participate'
ON CONFLICT DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin'
  AND p.key = 'standup:manage'
ON CONFLICT DO NOTHING;
