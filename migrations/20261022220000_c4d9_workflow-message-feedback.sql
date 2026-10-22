-- Up Migration
-- Light per-message feedback on agent replies. Interviews take an optional
-- thumbs up or down per question; home chat takes Good / Needs improvement /
-- Bad with a comment. One row per user per message. No judge runs on these.
-- subject_id is the interview id for 'interview' and the chat thread id for 'chat'.

CREATE TABLE workflow_message_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  surface TEXT NOT NULL,
  subject_id UUID NOT NULL,
  message_id UUID NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users (oid) ON DELETE CASCADE,
  rating TEXT NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_workflow_message_feedback_message_user UNIQUE (message_id, user_id),
  CONSTRAINT workflow_message_feedback_surface_check CHECK (surface IN ('interview', 'chat')),
  CONSTRAINT workflow_message_feedback_rating_check CHECK (
    (surface = 'interview' AND rating IN ('up', 'down') AND comment IS NULL)
    OR (surface = 'chat' AND rating IN ('good', 'needs_improvement', 'bad'))
  )
);

CREATE INDEX idx_workflow_message_feedback_subject
  ON workflow_message_feedback (project, surface, subject_id);

CREATE INDEX idx_workflow_message_feedback_project_created
  ON workflow_message_feedback (project, created_at);

-- Down Migration

DROP TABLE IF EXISTS workflow_message_feedback;
