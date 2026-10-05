-- Up Migration: playbook_definitions and playbook_definition_versions (TBI-011)
--
-- Two tables rather than one with a version column: a definition has identity that outlives any
-- single version, and a run pins a version id rather than a definition id.
--
-- A published version's content is frozen. That rule is NOT expressed here as a constraint —
-- "no column may change once status = 'published', except status" needs a trigger, and a trigger
-- puts business logic in a second place. It lives in the service and is proven by a test, which is
-- what TBI-011's definition of done asks for. What the database does guarantee is the narrower
-- backstop that matters most: a version referenced by a run cannot be hard-deleted (the restrict
-- foreign key arrives with playbook_runs in the next migration).

CREATE TABLE playbook_definitions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project     TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT,
  created_by  TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT playbook_definitions_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE INDEX idx_playbook_definitions_project_created
  ON playbook_definitions (project, created_at DESC);

-- Two playbooks in one project sharing a name would make the status view ambiguous about which one
-- a run belongs to. Compared case- and whitespace-insensitively, as apex_releases does.
CREATE UNIQUE INDEX uq_playbook_definitions_project_name
  ON playbook_definitions (project, lower(btrim(name)));

CREATE TABLE playbook_definition_versions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id  UUID        NOT NULL REFERENCES playbook_definitions(id) ON DELETE CASCADE,
  version_number INTEGER     NOT NULL CHECK (version_number >= 1),
  graph          JSONB       NOT NULL DEFAULT '{"nodes": [], "edges": []}'::jsonb,
  status         TEXT        NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft', 'published', 'deprecated', 'archived')),
  published_by   TEXT        REFERENCES app_users(oid) ON DELETE SET NULL,
  published_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_playbook_definition_versions_number UNIQUE (definition_id, version_number)
);

-- Deleting a definition takes its versions with it (CASCADE above), but a version referenced by a
-- run blocks that deletion through the run's own restrict-mode foreign key, so history survives.

CREATE INDEX idx_playbook_definition_versions_definition
  ON playbook_definition_versions (definition_id, version_number DESC);

-- Finding the currently published version of a definition is the hot lookup when starting a run.
CREATE INDEX idx_playbook_definition_versions_status
  ON playbook_definition_versions (definition_id, status);

-- Down Migration

DROP INDEX IF EXISTS idx_playbook_definition_versions_status;
DROP INDEX IF EXISTS idx_playbook_definition_versions_definition;
DROP TABLE IF EXISTS playbook_definition_versions;

DROP INDEX IF EXISTS uq_playbook_definitions_project_name;
DROP INDEX IF EXISTS idx_playbook_definitions_project_created;
DROP TABLE IF EXISTS playbook_definitions;
