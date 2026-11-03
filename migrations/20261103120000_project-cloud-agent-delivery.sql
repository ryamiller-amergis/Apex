-- Up Migration
--
-- Per-project Cloud Agent pull-request settings. The target branch is where
-- the work branch is created and where the pull request merges. Required
-- reviewers are Azure DevOps team or group names for that project.

CREATE TABLE IF NOT EXISTS project_cloud_agent_delivery (
  settings_id uuid PRIMARY KEY REFERENCES project_skill_settings(id) ON DELETE CASCADE,
  target_branch text,
  required_reviewers jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_cloud_agent_delivery_reviewers_array_check
    CHECK (jsonb_typeof(required_reviewers) = 'array')
);

-- Down Migration

DROP TABLE IF EXISTS project_cloud_agent_delivery;
