-- Migration: apex-work-board
-- Creates apex_work_items, apex_work_item_collaborators, apex_work_item_events

-- UP

CREATE TABLE apex_work_items (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_number       SERIAL      NOT NULL,
  title             TEXT        NOT NULL,
  outcome           TEXT        NOT NULL DEFAULT '',
  type              TEXT        NOT NULL CHECK (type IN ('PBI', 'TBI', 'Bug')),
  status            TEXT        NOT NULL DEFAULT 'idea'
                                  CHECK (status IN ('idea', 'ready', 'in-progress', 'review', 'done')),
  owner_oid         TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  acceptance_criteria JSONB     NOT NULL DEFAULT '[]',
  branch            TEXT,
  pr_url            TEXT        CHECK (pr_url IS NULL OR pr_url ~* '^https://'),
  position          INTEGER     NOT NULL DEFAULT 0,

  -- source provenance
  source_type       TEXT        NOT NULL DEFAULT 'standalone'
                                  CHECK (source_type IN ('prd', 'feature_request', 'standalone')),
  prd_id            UUID        REFERENCES interviews(id) ON DELETE SET NULL,
  backlog_item_id   TEXT,
  feature_request_id UUID       REFERENCES feature_requests(id) ON DELETE SET NULL,

  -- hierarchy breadcrumb (from PRD backlog)
  epic_id           TEXT,
  epic_title        TEXT,
  feature_id        TEXT,
  feature_title     TEXT,

  -- audit
  created_by        TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  updated_by        TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent duplicate materialization from the same PRD backlog item
CREATE UNIQUE INDEX idx_apex_work_items_prd_backlog
  ON apex_work_items (prd_id, backlog_item_id)
  WHERE prd_id IS NOT NULL AND backlog_item_id IS NOT NULL;

CREATE INDEX idx_apex_work_items_owner_status  ON apex_work_items (owner_oid, status);
CREATE INDEX idx_apex_work_items_status_pos    ON apex_work_items (status, position);
CREATE INDEX idx_apex_work_items_feature_request ON apex_work_items (feature_request_id) WHERE feature_request_id IS NOT NULL;

-- Collaborators junction

CREATE TABLE apex_work_item_collaborators (
  work_item_id  UUID  NOT NULL REFERENCES apex_work_items(id) ON DELETE CASCADE,
  user_oid      TEXT  NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_apex_work_item_collaborators PRIMARY KEY (work_item_id, user_oid)
);

CREATE INDEX idx_apex_work_item_collab_user ON apex_work_item_collaborators (user_oid);

-- Immutable activity events

CREATE TABLE apex_work_item_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id  UUID        NOT NULL REFERENCES apex_work_items(id) ON DELETE CASCADE,
  actor_id      TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  action        TEXT        NOT NULL
                              CHECK (action IN ('created', 'updated', 'moved', 'assigned',
                                                'collaborators_updated', 'ac_toggled',
                                                'linked', 'unlinked')),
  from_status   TEXT,
  to_status     TEXT,
  details       JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_apex_work_item_events_item ON apex_work_item_events (work_item_id, created_at);

-- DOWN

-- DROP TABLE IF EXISTS apex_work_item_events;
-- DROP TABLE IF EXISTS apex_work_item_collaborators;
-- DROP INDEX IF EXISTS idx_apex_work_items_prd_backlog;
-- DROP INDEX IF EXISTS idx_apex_work_items_owner_status;
-- DROP INDEX IF EXISTS idx_apex_work_items_status_pos;
-- DROP INDEX IF EXISTS idx_apex_work_items_feature_request;
-- DROP TABLE IF EXISTS apex_work_items;
