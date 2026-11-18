-- Up Migration
-- Brainstorm sessions linked to an Interview as Linked Context. The latest artifact
-- of each linked session grounds the Interview's agent turns. Counts toward the
-- same capacity of 10 as ADR and Design Module links.

CREATE TABLE interview_brainstorm_links (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id           UUID        NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  brainstorm_session_id  UUID        NOT NULL REFERENCES brainstorm_sessions(id) ON DELETE CASCADE,
  linked_by              TEXT        NOT NULL,
  linked_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_interview_brainstorm_links_interview_session UNIQUE (interview_id, brainstorm_session_id)
);

CREATE INDEX idx_interview_brainstorm_links_session_id
  ON interview_brainstorm_links (brainstorm_session_id);

-- Down Migration

DROP TABLE IF EXISTS interview_brainstorm_links;
