-- Up Migration: Calendar Work-Item Assistant tables + feature flag seed

-- Session: owner-scoped, holds immutable selected-item scope and thread link.
CREATE TABLE work_item_assistant_sessions (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id           TEXT        NOT NULL,
  project                 TEXT        NOT NULL,
  area_path               TEXT        NOT NULL DEFAULT '',
  anchor_work_item_id     INTEGER     NOT NULL,
  selected_work_item_ids  JSONB       NOT NULL DEFAULT '[]',
  context_snapshot        JSONB       NOT NULL DEFAULT '[]',
  thread_id               UUID        REFERENCES chat_threads(id) ON DELETE SET NULL,
  status                  TEXT        NOT NULL DEFAULT 'active',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_work_item_assistant_sessions_owner
  ON work_item_assistant_sessions(owner_user_id);
CREATE INDEX idx_work_item_assistant_sessions_project
  ON work_item_assistant_sessions(project, anchor_work_item_id);
CREATE INDEX idx_work_item_assistant_sessions_thread
  ON work_item_assistant_sessions(thread_id);

-- Proposal: versioned immutable change set staged by the agent.
CREATE TABLE work_item_change_proposals (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID        NOT NULL REFERENCES work_item_assistant_sessions(id) ON DELETE CASCADE,
  change_set    JSONB       NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending',
  item_results  JSONB,
  resolved_by   TEXT,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_work_item_change_proposals_session
  ON work_item_change_proposals(session_id, created_at DESC);

-- Per-project calendar assistant skill/model columns.
ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS calendar_assistant_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS calendar_assistant_model      TEXT;

-- Seed the feature flag (disabled by default — rollout is a Platform Admin action).
INSERT INTO feature_flags (key, description, enabled, lifecycle, cleanup_ready, created_by)
VALUES (
  'calendar-work-item-assistant',
  'Enables the Calendar Work-Item Assistant: contextual AI that proposes Description/AC changes with a mandatory diff-review gate before writing to ADO',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flag_rules
WHERE flag_id = (SELECT id FROM feature_flags WHERE key = 'calendar-work-item-assistant');
DELETE FROM feature_flags WHERE key = 'calendar-work-item-assistant';

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS calendar_assistant_skill_path,
  DROP COLUMN IF EXISTS calendar_assistant_model;

DROP TABLE IF EXISTS work_item_change_proposals;
DROP TABLE IF EXISTS work_item_assistant_sessions;
