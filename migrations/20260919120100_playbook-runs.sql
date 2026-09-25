-- Up Migration: playbook_runs (TBI-012)
--
-- Apex owns run truth (BR-001). Everything needed to say what happened and what happens next lives
-- here and in playbook_step_runs; the engine's own tables are a disposable execution cache.
--
-- The status vocabulary is constrained at the database level rather than only in TypeScript, because
-- a typo reaching this column would silently mis-render the status view and there is no later point
-- at which anything would catch it.
--
-- `expired` is a peer of the other terminal states, not a flag on `failed`: an approval gate nobody
-- answered is not a malfunction, and an operator needs to tell those apart at a glance.

CREATE TABLE playbook_runs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project               TEXT        NOT NULL,
  -- Restrict, not cascade: a version referenced by a run is never hard-deleted, so audit history
  -- survives even when someone tidies up definitions. This is BR-006's database backstop.
  definition_version_id UUID        NOT NULL
                                      REFERENCES playbook_definition_versions(id) ON DELETE RESTRICT,
  -- The authorization identity for the whole run (BR-003). The approver of a gate permits
  -- continuation but does not lend authority, so no approver column appears here.
  initiator_user_id     TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  status                TEXT        NOT NULL DEFAULT 'running'
                                      CHECK (status IN ('running', 'suspended', 'completed',
                                                        'cancelled', 'failed', 'expired')),
  -- Incremented by the runtime as steps execute, never computed on read. The structural guards in
  -- FEAT-005 are synchronous; making a synchronous guard depend on an aggregate scan is how
  -- admission checks become slow enough that someone disables them.
  step_count            INTEGER     NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  agent_step_count      INTEGER     NOT NULL DEFAULT 0 CHECK (agent_step_count >= 0),
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The status view's list query: most recent runs in a project.
CREATE INDEX idx_playbook_runs_project_started
  ON playbook_runs (project, started_at DESC);

-- Counting active runs against the per-project cap in FEAT-005.
CREATE INDEX idx_playbook_runs_project_status
  ON playbook_runs (project, status);

-- Postgres does not index the referencing side of a foreign key automatically, and the restrict
-- check above runs on every attempted version delete.
CREATE INDEX idx_playbook_runs_definition_version
  ON playbook_runs (definition_version_id);

-- Down Migration

DROP INDEX IF EXISTS idx_playbook_runs_definition_version;
DROP INDEX IF EXISTS idx_playbook_runs_project_status;
DROP INDEX IF EXISTS idx_playbook_runs_project_started;
DROP TABLE IF EXISTS playbook_runs;
