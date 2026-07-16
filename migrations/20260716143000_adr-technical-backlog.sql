CREATE TABLE IF NOT EXISTS technical_backlog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adr_id UUID NOT NULL UNIQUE REFERENCES adrs(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT 'Apex',
  source_project TEXT NOT NULL,
  source_repo TEXT NOT NULL,
  source_slug TEXT,
  implementation_context TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'in_progress', 'completed')),
  created_by TEXT NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_technical_backlog_project_status
  ON technical_backlog_items(project, status, created_at DESC);

ALTER TABLE dev_sessions
  ADD COLUMN IF NOT EXISTS technical_backlog_item_id UUID
    REFERENCES technical_backlog_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_dev_sessions_technical_backlog_item
  ON dev_sessions(technical_backlog_item_id);
