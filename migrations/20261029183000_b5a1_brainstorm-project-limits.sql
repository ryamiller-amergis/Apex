-- Up Migration
-- FEAT-002: per-project clone limits, and the source/citation columns TBI-001
-- did not include. Additive. No column stores file content or credentials.

CREATE TABLE IF NOT EXISTS brainstorm_project_limits (
  project                text PRIMARY KEY,
  max_workspace_bytes    bigint NOT NULL,
  max_concurrent_clones  integer NOT NULL,
  updated_by             text NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brainstorm_project_limits_bytes_check CHECK (max_workspace_bytes > 0),
  CONSTRAINT brainstorm_project_limits_clones_check CHECK (max_concurrent_clones > 0)
);

UPDATE brainstorm_sources
  SET workspace_state = 'preparing'
  WHERE workspace_state = 'pending';

ALTER TABLE brainstorm_sources
  ADD COLUMN IF NOT EXISTS ref_id text,
  ADD COLUMN IF NOT EXISTS reason_code text,
  ADD COLUMN IF NOT EXISTS reason_text text,
  ADD COLUMN IF NOT EXISTS workspace_removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS grounding_provider text,
  ADD COLUMN IF NOT EXISTS grounding_project text,
  ADD COLUMN IF NOT EXISTS grounding_repository text,
  ADD COLUMN IF NOT EXISTS mcp_read_only_tool_count integer;

ALTER TABLE brainstorm_sources
  ALTER COLUMN workspace_state SET DEFAULT 'preparing';

ALTER TABLE brainstorm_sources
  DROP CONSTRAINT IF EXISTS brainstorm_sources_state_check;

ALTER TABLE brainstorm_sources
  ADD CONSTRAINT brainstorm_sources_state_check CHECK (
    workspace_state IN (
      'preparing', 'ready', 'failed', 'cleaned',
      'restoring', 'unavailable', 'removing', 'removed'
    )
  );

CREATE INDEX IF NOT EXISTS idx_brainstorm_sources_project_session
  ON brainstorm_sources (project, session_id);
CREATE INDEX IF NOT EXISTS idx_brainstorm_sources_state_updated
  ON brainstorm_sources (workspace_state, updated_at);

ALTER TABLE brainstorm_citations
  ADD COLUMN IF NOT EXISTS source_kind text,
  ADD COLUMN IF NOT EXISTS source_name text,
  ADD COLUMN IF NOT EXISTS path text,
  ADD COLUMN IF NOT EXISTS mcp_server_name text,
  ADD COLUMN IF NOT EXISTS mcp_tool_id text;

-- Down Migration

ALTER TABLE brainstorm_citations
  DROP COLUMN IF EXISTS mcp_tool_id,
  DROP COLUMN IF EXISTS mcp_server_name,
  DROP COLUMN IF EXISTS path,
  DROP COLUMN IF EXISTS source_name,
  DROP COLUMN IF EXISTS source_kind;

DROP INDEX IF EXISTS idx_brainstorm_sources_state_updated;
DROP INDEX IF EXISTS idx_brainstorm_sources_project_session;

ALTER TABLE brainstorm_sources DROP CONSTRAINT IF EXISTS brainstorm_sources_state_check;
ALTER TABLE brainstorm_sources ALTER COLUMN workspace_state SET DEFAULT 'pending';
ALTER TABLE brainstorm_sources
  DROP COLUMN IF EXISTS grounding_repository,
  DROP COLUMN IF EXISTS grounding_project,
  DROP COLUMN IF EXISTS grounding_provider,
  DROP COLUMN IF EXISTS workspace_removed_at,
  DROP COLUMN IF EXISTS reason_text,
  DROP COLUMN IF EXISTS reason_code,
  DROP COLUMN IF EXISTS mcp_read_only_tool_count,
  DROP COLUMN IF EXISTS ref_id;

DROP TABLE IF EXISTS brainstorm_project_limits;
