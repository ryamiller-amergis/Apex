-- Up Migration
-- FEAT-002 / TBI-004, PBI-002: platform-level allow-list of project and repository
-- pairs that may run builds, plus an append-only audit of every change.
-- No foreign key to project_skill_settings: its project column is not unique.

CREATE TABLE build_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project text NOT NULL,
  repository text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT build_allowlist_project_repository_key UNIQUE (project, repository)
);

CREATE TABLE build_allowlist_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  project text NOT NULL,
  repository text NOT NULL,
  actor_id text NOT NULL,
  actor_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT build_allowlist_audit_action_check CHECK (action IN ('added', 'removed'))
);

CREATE INDEX build_allowlist_audit_created_at_idx ON build_allowlist_audit (created_at);

-- Down Migration

DROP TABLE IF EXISTS build_allowlist_audit;
DROP TABLE IF EXISTS build_allowlist;
