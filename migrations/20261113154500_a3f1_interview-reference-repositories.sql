-- Up Migration
-- Read-only reference repositories for an Interview. Each row points at a
-- repository an administrator added to the project's Brainstorm catalog.

CREATE TABLE interview_reference_repositories (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id           UUID        NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  catalog_repository_id  UUID        NOT NULL REFERENCES brainstorm_repositories(id) ON DELETE CASCADE,
  linked_by              TEXT        NOT NULL,
  linked_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_interview_reference_repositories_interview_repo UNIQUE (interview_id, catalog_repository_id)
);

CREATE INDEX idx_interview_reference_repositories_interview_id
  ON interview_reference_repositories (interview_id);

-- Down Migration

DROP TABLE IF EXISTS interview_reference_repositories;
