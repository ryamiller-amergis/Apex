-- Up Migration
CREATE TABLE IF NOT EXISTS release_epic_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  area_path TEXT NOT NULL,
  ado_epic_id INTEGER NOT NULL,
  sort_rank INTEGER NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_release_epic_orders_scope_epic UNIQUE (project, area_path, ado_epic_id)
);

CREATE INDEX IF NOT EXISTS idx_release_epic_orders_scope
  ON release_epic_orders (project, area_path, sort_rank);

-- Down Migration
-- DROP TABLE IF EXISTS release_epic_orders;
