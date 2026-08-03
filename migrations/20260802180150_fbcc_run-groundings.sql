-- Up Migration

CREATE TABLE run_groundings (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type      TEXT        NOT NULL CHECK (run_type IN ('chat', 'one_shot', 'service')),
  run_id        TEXT        NOT NULL,
  repo_role     TEXT        NOT NULL CHECK (repo_role IN ('target', 'skill')),
  provider      TEXT        NOT NULL CHECK (provider IN ('github', 'azure_devops')),
  project       TEXT        NOT NULL,
  repository    TEXT        NOT NULL,
  branch        TEXT        NOT NULL,
  grounded_sha  TEXT        NOT NULL,
  grounded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_run_groundings_run_lookup
  ON run_groundings (run_type, run_id);

CREATE INDEX idx_run_groundings_active_repo_branch
  ON run_groundings (provider, project, repository, branch)
  WHERE is_active;

CREATE UNIQUE INDEX uq_run_groundings_active_run_role
  ON run_groundings (run_type, run_id, repo_role)
  WHERE is_active;

-- Down Migration

DROP TABLE run_groundings;
