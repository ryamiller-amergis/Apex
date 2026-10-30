-- Up Migration
-- Brainstorm-owned repositories. Separate from Project Settings skill repos.
-- The clone URL never contains a username, password, or token.

CREATE TABLE IF NOT EXISTS brainstorm_repositories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project       text NOT NULL,
  display_name  text NOT NULL,
  clone_url     text NOT NULL,
  branch        text NOT NULL,
  status        text NOT NULL DEFAULT 'not_cloned',
  commit_sha    text,
  error         text,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brainstorm_repositories_status_check
    CHECK (status IN ('not_cloned', 'cloning', 'ready', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_brainstorm_repositories_url_branch
  ON brainstorm_repositories (project, clone_url, branch);

CREATE INDEX IF NOT EXISTS idx_brainstorm_repositories_project
  ON brainstorm_repositories (project);

-- Down Migration

DROP TABLE IF EXISTS brainstorm_repositories;
