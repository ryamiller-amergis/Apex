-- Up Migration: Work Board comments, mentions, attachments + event actions

CREATE TABLE IF NOT EXISTS apex_work_item_comments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id  UUID        NOT NULL REFERENCES apex_work_items(id) ON DELETE CASCADE,
  project       TEXT        NOT NULL,
  author_oid    TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  body          TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT apex_work_item_comments_body_not_blank CHECK (length(btrim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_apex_work_item_comments_item
  ON apex_work_item_comments (work_item_id, created_at);

CREATE INDEX IF NOT EXISTS idx_apex_work_item_comments_project
  ON apex_work_item_comments (project);

CREATE TABLE IF NOT EXISTS apex_work_item_attachments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id  UUID        NOT NULL REFERENCES apex_work_items(id) ON DELETE CASCADE,
  project       TEXT        NOT NULL,
  file_name     TEXT        NOT NULL,
  content_type  TEXT        NOT NULL DEFAULT 'application/octet-stream',
  byte_size     INTEGER     NOT NULL DEFAULT 0,
  storage_path  TEXT        NOT NULL,
  uploaded_by   TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT apex_work_item_attachments_name_not_blank CHECK (length(btrim(file_name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_apex_work_item_attachments_item
  ON apex_work_item_attachments (work_item_id);

-- Expand event action check for comment / attachment / release changes
ALTER TABLE apex_work_item_events DROP CONSTRAINT IF EXISTS apex_work_item_events_action_check;
ALTER TABLE apex_work_item_events
  ADD CONSTRAINT apex_work_item_events_action_check
  CHECK (action IN (
    'created', 'updated', 'moved', 'assigned',
    'collaborators_updated', 'ac_toggled',
    'linked', 'unlinked',
    'commented', 'attachment_added', 'attachment_removed',
    'release_set', 'mentioned'
  ));

-- Down Migration

ALTER TABLE apex_work_item_events DROP CONSTRAINT IF EXISTS apex_work_item_events_action_check;
ALTER TABLE apex_work_item_events
  ADD CONSTRAINT apex_work_item_events_action_check
  CHECK (action IN (
    'created', 'updated', 'moved', 'assigned',
    'collaborators_updated', 'ac_toggled',
    'linked', 'unlinked'
  ));

DROP TABLE IF EXISTS apex_work_item_attachments;
DROP TABLE IF EXISTS apex_work_item_comments;
