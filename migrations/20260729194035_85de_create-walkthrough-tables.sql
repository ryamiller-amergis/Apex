-- Up Migration
-- FEAT-001 TBI-001: relational Walkthrough storage (4 tables + indexes)

CREATE TABLE walkthroughs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_name   TEXT NOT NULL,
  user_title      TEXT NOT NULL,
  why_it_matters  TEXT NOT NULL DEFAULT '',
  lifecycle       TEXT NOT NULL DEFAULT 'draft'
                    CHECK (lifecycle IN ('draft', 'published', 'unpublished', 'archived')),
  priority        INTEGER NOT NULL DEFAULT 0,
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  published_at    TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Active eligibility / ordering path (lifecycle + priority + publish date)
CREATE INDEX idx_walkthroughs_lifecycle_priority_published
  ON walkthroughs (lifecycle, priority DESC, published_at ASC);

CREATE TABLE walkthrough_steps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  walkthrough_id  UUID NOT NULL REFERENCES walkthroughs(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  heading         TEXT NOT NULL,
  body_markdown   TEXT NOT NULL DEFAULT '',
  image_url       TEXT,
  cta_label       TEXT,
  cta_route       TEXT,
  -- Flat nullable anchor columns (PRD / PostgreSQL conventions) — not JSONB
  anchor_key      TEXT,
  target_route    TEXT,
  placement       TEXT,
  CONSTRAINT uq_walkthrough_steps_ordinal UNIQUE (walkthrough_id, ordinal),
  CONSTRAINT chk_walkthrough_steps_anchor_tuple CHECK (
    (anchor_key IS NULL AND target_route IS NULL AND placement IS NULL)
    OR (anchor_key IS NOT NULL AND target_route IS NOT NULL AND placement IS NOT NULL)
  )
);

CREATE INDEX idx_walkthrough_steps_walkthrough_ordinal
  ON walkthrough_steps (walkthrough_id, ordinal);

CREATE TABLE walkthrough_targeting_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  walkthrough_id  UUID NOT NULL REFERENCES walkthroughs(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  value           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_walkthrough_targeting_rules_type_value
  ON walkthrough_targeting_rules (type, value);

CREATE INDEX idx_walkthrough_targeting_rules_walkthrough
  ON walkthrough_targeting_rules (walkthrough_id);

CREATE TABLE walkthrough_progress (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  walkthrough_id    UUID NOT NULL REFERENCES walkthroughs(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  revision          INTEGER NOT NULL CHECK (revision >= 1),
  -- Persisted statuses only; acknowledged is derived in application code
  status            TEXT NOT NULL
                      CHECK (status IN ('seen', 'completed', 'dismissed')),
  last_step_id      UUID REFERENCES walkthrough_steps(id) ON DELETE SET NULL,
  seen_at           TIMESTAMPTZ,
  acknowledged_at   TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_walkthrough_progress_user_revision
    UNIQUE (walkthrough_id, user_id, revision)
);

CREATE INDEX idx_walkthrough_progress_user_walkthrough_revision
  ON walkthrough_progress (user_id, walkthrough_id, revision);

CREATE INDEX idx_walkthrough_progress_walkthrough_revision
  ON walkthrough_progress (walkthrough_id, revision);

-- Down Migration
DROP TABLE IF EXISTS walkthrough_progress;
DROP TABLE IF EXISTS walkthrough_targeting_rules;
DROP TABLE IF EXISTS walkthrough_steps;
DROP TABLE IF EXISTS walkthroughs;
