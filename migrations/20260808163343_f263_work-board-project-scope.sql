-- Up Migration: project-scope apex_work_items (native Work Board foundation)

-- Add project column (backfill existing rows to Apex)
ALTER TABLE apex_work_items
  ADD COLUMN IF NOT EXISTS project TEXT;

UPDATE apex_work_items SET project = 'Apex' WHERE project IS NULL;

ALTER TABLE apex_work_items
  ALTER COLUMN project SET NOT NULL;

-- Per-project item numbers: drop global serial uniqueness assumptions
-- Keep item_number values; enforce uniqueness per project going forward
ALTER TABLE apex_work_items
  ALTER COLUMN item_number DROP DEFAULT;

DROP SEQUENCE IF EXISTS apex_work_items_item_number_seq CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_apex_work_items_project_item_number
  ON apex_work_items (project, item_number);

CREATE INDEX IF NOT EXISTS idx_apex_work_items_project_status_pos
  ON apex_work_items (project, status, position);

CREATE INDEX IF NOT EXISTS idx_apex_work_items_project_owner
  ON apex_work_items (project, owner_oid);

-- Optional due date (no sprints / estimates in v1)
ALTER TABLE apex_work_items
  ADD COLUMN IF NOT EXISTS due_date DATE;

-- Down Migration

DROP INDEX IF EXISTS idx_apex_work_items_project_owner;
DROP INDEX IF EXISTS idx_apex_work_items_project_status_pos;
DROP INDEX IF EXISTS idx_apex_work_items_project_item_number;

ALTER TABLE apex_work_items DROP COLUMN IF EXISTS due_date;
ALTER TABLE apex_work_items DROP COLUMN IF EXISTS project;

CREATE SEQUENCE IF NOT EXISTS apex_work_items_item_number_seq;
SELECT setval('apex_work_items_item_number_seq', COALESCE((SELECT MAX(item_number) FROM apex_work_items), 1));
ALTER TABLE apex_work_items ALTER COLUMN item_number SET DEFAULT nextval('apex_work_items_item_number_seq');
