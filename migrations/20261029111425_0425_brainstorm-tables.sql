-- Up Migration
-- FEAT-001 / TBI-001: Brainstorm storage. Every table carries `project` so each
-- query can filter by project. Sources store metadata only: no file content and
-- no credentials.

CREATE TABLE IF NOT EXISTS brainstorm_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project          text NOT NULL,
  creator_id       text NOT NULL,
  state            text NOT NULL DEFAULT 'active',
  model            text NOT NULL,
  title            text,
  artifact_type    text,
  chat_thread_id   uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  failure_reason   text,
  version          integer NOT NULL DEFAULT 1,
  created_by       text NOT NULL,
  updated_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brainstorm_sessions_state_check CHECK (state IN ('active', 'ended', 'failed')),
  CONSTRAINT brainstorm_sessions_version_check CHECK (version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_brainstorm_sessions_chat_thread
  ON brainstorm_sessions (chat_thread_id);
CREATE INDEX IF NOT EXISTS idx_brainstorm_sessions_project_activity
  ON brainstorm_sessions (project, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_brainstorm_sessions_project_creator
  ON brainstorm_sessions (project, creator_id);
CREATE INDEX IF NOT EXISTS idx_brainstorm_sessions_active_activity
  ON brainstorm_sessions (last_activity_at)
  WHERE state = 'active';

CREATE TABLE IF NOT EXISTS brainstorm_messages (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               uuid NOT NULL REFERENCES brainstorm_sessions(id) ON DELETE CASCADE,
  project                  text NOT NULL,
  role                     text NOT NULL,
  content                  text NOT NULL DEFAULT '',
  status                   text NOT NULL,
  turn_id                  uuid NOT NULL,
  run_id                   uuid,
  failure_code             text,
  failure_summary          text,
  retry_of_message_id      uuid REFERENCES brainstorm_messages(id) ON DELETE SET NULL,
  superseded_by_message_id uuid REFERENCES brainstorm_messages(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  completed_at             timestamptz,
  CONSTRAINT brainstorm_messages_role_check CHECK (role IN ('user', 'assistant')),
  CONSTRAINT brainstorm_messages_status_check
    CHECK (status IN ('streaming', 'completed', 'failed', 'cancelled')),
  CONSTRAINT brainstorm_messages_failure_code_check CHECK (
    failure_code IS NULL OR failure_code IN (
      'run_not_started', 'model_error', 'deadline_exceeded',
      'worker_refused_spec', 'cancelled', 'unknown'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_brainstorm_messages_session_created
  ON brainstorm_messages (session_id, created_at);
-- Retries reuse the turn id, so only the original row per turn and role is unique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_brainstorm_messages_session_turn_role
  ON brainstorm_messages (session_id, turn_id, role)
  WHERE retry_of_message_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_brainstorm_messages_one_streaming
  ON brainstorm_messages (session_id)
  WHERE role = 'assistant' AND status = 'streaming';
CREATE INDEX IF NOT EXISTS idx_brainstorm_messages_run
  ON brainstorm_messages (run_id)
  WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS brainstorm_sources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid NOT NULL REFERENCES brainstorm_sessions(id) ON DELETE CASCADE,
  project            text NOT NULL,
  kind               text NOT NULL,
  display_name       text NOT NULL,
  clone_url          text,
  requested_revision text,
  resolved_sha       text,
  workspace_state    text NOT NULL DEFAULT 'pending',
  size_bytes         bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brainstorm_sources_session
  ON brainstorm_sources (session_id);

CREATE TABLE IF NOT EXISTS brainstorm_artifacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES brainstorm_sessions(id) ON DELETE CASCADE,
  project       text NOT NULL,
  artifact_type text NOT NULL,
  markdown      text NOT NULL DEFAULT '',
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brainstorm_artifacts_version_check CHECK (version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_brainstorm_artifacts_session
  ON brainstorm_artifacts (session_id);

CREATE TABLE IF NOT EXISTS brainstorm_artifact_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id     uuid NOT NULL REFERENCES brainstorm_artifacts(id) ON DELETE CASCADE,
  project         text NOT NULL,
  sequence        integer NOT NULL,
  markdown        text NOT NULL,
  change_origin   text NOT NULL,
  checkpoint_name text,
  author_id       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_brainstorm_artifact_versions_sequence
  ON brainstorm_artifact_versions (artifact_id, sequence);

CREATE TABLE IF NOT EXISTS brainstorm_citations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES brainstorm_sessions(id) ON DELETE CASCADE,
  project         text NOT NULL,
  message_id      uuid REFERENCES brainstorm_messages(id) ON DELETE CASCADE,
  source_id       uuid REFERENCES brainstorm_sources(id) ON DELETE SET NULL,
  path_or_tool    text NOT NULL,
  pinned_revision text,
  claim_text      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brainstorm_citations_session
  ON brainstorm_citations (session_id);
CREATE INDEX IF NOT EXISTS idx_brainstorm_citations_message
  ON brainstorm_citations (message_id);

CREATE TABLE IF NOT EXISTS brainstorm_actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES brainstorm_sessions(id) ON DELETE CASCADE,
  project          text NOT NULL,
  action_kind      text NOT NULL,
  target_module    text NOT NULL,
  state            text NOT NULL DEFAULT 'previewed',
  preview_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed_at     timestamptz,
  idempotency_key  text NOT NULL,
  result_ref       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_brainstorm_actions_idempotency
  ON brainstorm_actions (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_brainstorm_actions_session
  ON brainstorm_actions (session_id);

-- Down Migration

DROP TABLE IF EXISTS brainstorm_actions;
DROP TABLE IF EXISTS brainstorm_citations;
DROP TABLE IF EXISTS brainstorm_artifact_versions;
DROP TABLE IF EXISTS brainstorm_artifacts;
DROP TABLE IF EXISTS brainstorm_sources;
DROP TABLE IF EXISTS brainstorm_messages;
DROP TABLE IF EXISTS brainstorm_sessions;
