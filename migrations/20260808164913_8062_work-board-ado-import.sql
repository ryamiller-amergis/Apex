-- Up Migration: ADO provenance for Work Board import (idempotent ADO → board)

ALTER TABLE apex_work_items
  ADD COLUMN IF NOT EXISTS ado_work_item_id INTEGER;

-- One Apex row per ADO work item within a project (nulls allowed for native items)
CREATE UNIQUE INDEX IF NOT EXISTS idx_apex_work_items_project_ado
  ON apex_work_items (project, ado_work_item_id)
  WHERE ado_work_item_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_apex_work_items_project_ado;
ALTER TABLE apex_work_items DROP COLUMN IF EXISTS ado_work_item_id;
