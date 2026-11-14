-- Up Migration
ALTER TABLE standup_configs
  ADD COLUMN IF NOT EXISTS delivery_model TEXT NOT NULL DEFAULT 'flow',
  ADD COLUMN IF NOT EXISTS goal_source TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS team_goal TEXT,
  ADD COLUMN IF NOT EXISTS policy JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE standup_sessions
  ADD COLUMN IF NOT EXISTS team_pulse JSONB;

ALTER TABLE standup_participants
  ADD COLUMN IF NOT EXISTS prepared_brief JSONB;

CREATE TABLE IF NOT EXISTS standup_action_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES standup_sessions(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES standup_participants(id) ON DELETE SET NULL,
  project TEXT NOT NULL,
  work_item_id INTEGER NOT NULL,
  work_item_title TEXT NOT NULL,
  proposal_type TEXT NOT NULL,
  field_name TEXT NOT NULL,
  current_value TEXT,
  proposed_value TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'at_risk',
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_standup_action_proposals_session
  ON standup_action_proposals(session_id);

CREATE INDEX IF NOT EXISTS idx_standup_action_proposals_project_status
  ON standup_action_proposals(project, status);

-- Down Migration
DROP INDEX IF EXISTS idx_standup_action_proposals_project_status;
DROP INDEX IF EXISTS idx_standup_action_proposals_session;
DROP TABLE IF EXISTS standup_action_proposals;

ALTER TABLE standup_participants
  DROP COLUMN IF EXISTS prepared_brief;

ALTER TABLE standup_sessions
  DROP COLUMN IF EXISTS team_pulse;

ALTER TABLE standup_configs
  DROP COLUMN IF EXISTS policy,
  DROP COLUMN IF EXISTS team_goal,
  DROP COLUMN IF EXISTS goal_source,
  DROP COLUMN IF EXISTS delivery_model;
