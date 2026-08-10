-- Up Migration: native releases + hierarchy for Work Board (no sprints)

CREATE TABLE IF NOT EXISTS apex_releases (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project      TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  version      TEXT,
  target_date  DATE,
  status       TEXT        NOT NULL DEFAULT 'planned'
                             CHECK (status IN ('planned', 'active', 'shipped', 'cancelled')),
  position     INTEGER     NOT NULL DEFAULT 0,
  created_by   TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  updated_by   TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT apex_releases_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_apex_releases_project_target
  ON apex_releases (project, target_date NULLS LAST);

CREATE UNIQUE INDEX IF NOT EXISTS idx_apex_releases_project_name
  ON apex_releases (project, lower(btrim(name)));

-- Link work items to a target release
ALTER TABLE apex_work_items
  ADD COLUMN IF NOT EXISTS release_id UUID REFERENCES apex_releases(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_apex_work_items_release
  ON apex_work_items (release_id)
  WHERE release_id IS NOT NULL;

-- Real hierarchy (Epic → Feature → PBI/TBI/Bug)
ALTER TABLE apex_work_items
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES apex_work_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_apex_work_items_parent
  ON apex_work_items (parent_id)
  WHERE parent_id IS NOT NULL;

-- Expand allowed types to include Epic / Feature
ALTER TABLE apex_work_items DROP CONSTRAINT IF EXISTS apex_work_items_type_check;
ALTER TABLE apex_work_items
  ADD CONSTRAINT apex_work_items_type_check
  CHECK (type IN ('Epic', 'Feature', 'PBI', 'TBI', 'Bug'));

-- Dependency / predecessor links
CREATE TABLE IF NOT EXISTS apex_work_item_links (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project       TEXT        NOT NULL,
  source_id     UUID        NOT NULL REFERENCES apex_work_items(id) ON DELETE CASCADE,
  target_id     UUID        NOT NULL REFERENCES apex_work_items(id) ON DELETE CASCADE,
  link_type     TEXT        NOT NULL DEFAULT 'predecessor'
                              CHECK (link_type IN ('predecessor', 'related', 'blocks')),
  created_by    TEXT        NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT apex_work_item_links_no_self CHECK (source_id <> target_id),
  CONSTRAINT apex_work_item_links_unique UNIQUE (source_id, target_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_apex_work_item_links_target
  ON apex_work_item_links (target_id);

CREATE INDEX IF NOT EXISTS idx_apex_work_item_links_project
  ON apex_work_item_links (project);

-- Down Migration

DROP TABLE IF EXISTS apex_work_item_links;

ALTER TABLE apex_work_items DROP CONSTRAINT IF EXISTS apex_work_items_type_check;
ALTER TABLE apex_work_items
  ADD CONSTRAINT apex_work_items_type_check
  CHECK (type IN ('PBI', 'TBI', 'Bug'));

DROP INDEX IF EXISTS idx_apex_work_items_parent;
ALTER TABLE apex_work_items DROP COLUMN IF EXISTS parent_id;

DROP INDEX IF EXISTS idx_apex_work_items_release;
ALTER TABLE apex_work_items DROP COLUMN IF EXISTS release_id;

DROP TABLE IF EXISTS apex_releases;
