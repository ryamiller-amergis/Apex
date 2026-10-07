-- Up Migration
-- Playbook-owned interviews keep an optional run link and a profile snapshot.
-- The approved brief lives on interview tables, not on the Playbook step row.

ALTER TABLE interviews
  ADD COLUMN playbook_run_id UUID REFERENCES playbook_runs(id) ON DELETE RESTRICT,
  ADD COLUMN playbook_step_run_id UUID REFERENCES playbook_step_runs(id) ON DELETE RESTRICT,
  ADD COLUMN playbook_interview_mode TEXT,
  ADD COLUMN playbook_profile_key TEXT,
  ADD COLUMN playbook_profile_snapshot JSONB;

ALTER TABLE interviews
  ADD CONSTRAINT interviews_playbook_interview_mode_check
    CHECK (
      playbook_interview_mode IS NULL
      OR playbook_interview_mode IN ('human_led', 'multi_agent_assisted')
    );

ALTER TABLE interviews
  ADD CONSTRAINT interviews_playbook_linkage_check
    CHECK (
      (
        playbook_run_id IS NULL
        AND playbook_step_run_id IS NULL
        AND playbook_interview_mode IS NULL
        AND playbook_profile_key IS NULL
        AND playbook_profile_snapshot IS NULL
      )
      OR
      (
        playbook_run_id IS NOT NULL
        AND playbook_step_run_id IS NOT NULL
        AND playbook_interview_mode IS NOT NULL
        AND playbook_profile_key IS NOT NULL
        AND length(btrim(playbook_profile_key)) > 0
        AND playbook_profile_snapshot IS NOT NULL
        AND jsonb_typeof(playbook_profile_snapshot) = 'object'
      )
    );

-- One interview per Playbook step. Ordinary interviews leave the column null.
CREATE UNIQUE INDEX uq_interviews_playbook_step_run
  ON interviews (playbook_step_run_id)
  WHERE playbook_step_run_id IS NOT NULL;

CREATE INDEX idx_interviews_playbook_run
  ON interviews (playbook_run_id)
  WHERE playbook_run_id IS NOT NULL;

CREATE TABLE interview_briefs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id  UUID        NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  status        TEXT        NOT NULL DEFAULT 'draft',
  version       INTEGER     NOT NULL,
  sections      JSONB       NOT NULL,
  approved_by   TEXT        REFERENCES app_users(oid) ON DELETE RESTRICT,
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_interview_briefs_interview UNIQUE (interview_id),
  CONSTRAINT interview_briefs_status_check CHECK (status IN ('draft', 'approved')),
  CONSTRAINT interview_briefs_version_check CHECK (version >= 1),
  CONSTRAINT interview_briefs_approval_check CHECK (
    (status = 'draft' AND approved_by IS NULL AND approved_at IS NULL)
    OR
    (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT interview_briefs_sections_check CHECK (
    jsonb_typeof(sections) = 'object'
    AND sections ?& ARRAY['problemAndOutcome','users','scope','businessRules','scenarios','acceptanceCriteria','assumptions','unresolvedItems']
    AND (sections - ARRAY['problemAndOutcome','users','scope','businessRules','scenarios','acceptanceCriteria','assumptions','unresolvedItems']) = '{}'::jsonb
    AND jsonb_typeof(sections -> 'problemAndOutcome') = 'string'
    AND jsonb_typeof(sections -> 'users') = 'string'
    AND jsonb_typeof(sections -> 'scope') = 'string'
    AND jsonb_typeof(sections -> 'businessRules') = 'string'
    AND jsonb_typeof(sections -> 'scenarios') = 'string'
    AND jsonb_typeof(sections -> 'acceptanceCriteria') = 'string'
    AND jsonb_typeof(sections -> 'assumptions') = 'string'
    AND jsonb_typeof(sections -> 'unresolvedItems') = 'array'
  )
);

CREATE TABLE interview_brief_revisions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id     UUID        NOT NULL REFERENCES interview_briefs(id) ON DELETE CASCADE,
  interview_id UUID        NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  version      INTEGER     NOT NULL,
  status       TEXT        NOT NULL,
  sections     JSONB       NOT NULL,
  created_by   TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_interview_brief_revisions_brief_version UNIQUE (brief_id, version),
  CONSTRAINT interview_brief_revisions_status_check CHECK (status IN ('draft', 'approved')),
  CONSTRAINT interview_brief_revisions_version_check CHECK (version >= 1),
  CONSTRAINT interview_brief_revisions_sections_check CHECK (
    jsonb_typeof(sections) = 'object'
    AND sections ?& ARRAY['problemAndOutcome','users','scope','businessRules','scenarios','acceptanceCriteria','assumptions','unresolvedItems']
    AND (sections - ARRAY['problemAndOutcome','users','scope','businessRules','scenarios','acceptanceCriteria','assumptions','unresolvedItems']) = '{}'::jsonb
    AND jsonb_typeof(sections -> 'problemAndOutcome') = 'string'
    AND jsonb_typeof(sections -> 'users') = 'string'
    AND jsonb_typeof(sections -> 'scope') = 'string'
    AND jsonb_typeof(sections -> 'businessRules') = 'string'
    AND jsonb_typeof(sections -> 'scenarios') = 'string'
    AND jsonb_typeof(sections -> 'acceptanceCriteria') = 'string'
    AND jsonb_typeof(sections -> 'assumptions') = 'string'
    AND jsonb_typeof(sections -> 'unresolvedItems') = 'array'
  )
);

CREATE INDEX idx_interview_brief_revisions_interview
  ON interview_brief_revisions (interview_id, version);

-- Specialist result is structured JSON only. There is no chain-of-thought column.
CREATE TABLE interview_specialist_reviews (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id   UUID        NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  brief_version  INTEGER     NOT NULL,
  specialist     TEXT        NOT NULL,
  status         TEXT        NOT NULL,
  result         JSONB       NOT NULL,
  model          TEXT,
  duration_ms    INTEGER     NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT interview_specialist_reviews_specialist_check CHECK (length(btrim(specialist)) > 0),
  CONSTRAINT interview_specialist_reviews_status_check CHECK (status IN ('succeeded', 'failed')),
  CONSTRAINT interview_specialist_reviews_result_check CHECK (jsonb_typeof(result) = 'object'),
  CONSTRAINT interview_specialist_reviews_brief_version_check CHECK (brief_version >= 1),
  CONSTRAINT interview_specialist_reviews_duration_check CHECK (duration_ms >= 0)
);

CREATE INDEX idx_interview_specialist_reviews_interview_version
  ON interview_specialist_reviews (interview_id, brief_version);

CREATE INDEX idx_interview_specialist_reviews_specialist
  ON interview_specialist_reviews (specialist);

-- Down Migration

DROP TABLE IF EXISTS interview_specialist_reviews;
DROP TABLE IF EXISTS interview_brief_revisions;
DROP TABLE IF EXISTS interview_briefs;

DROP INDEX IF EXISTS uq_interviews_playbook_step_run;
DROP INDEX IF EXISTS idx_interviews_playbook_run;

ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_playbook_linkage_check;
ALTER TABLE interviews DROP CONSTRAINT IF EXISTS interviews_playbook_interview_mode_check;

ALTER TABLE interviews
  DROP COLUMN IF EXISTS playbook_profile_snapshot,
  DROP COLUMN IF EXISTS playbook_profile_key,
  DROP COLUMN IF EXISTS playbook_interview_mode,
  DROP COLUMN IF EXISTS playbook_step_run_id,
  DROP COLUMN IF EXISTS playbook_run_id;
