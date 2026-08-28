-- Up Migration

-- Per-module approval mode storage, keyed the same way as the reviewer pools
-- (project_approvers / project_approver_groups): one row per
-- (settings_id, document_type). Additive only — project_skill_settings.approval_mode
-- is retained so the in-flight completion read path and an older app build keep
-- resolving approval mode from the legacy column.
CREATE TABLE IF NOT EXISTS project_approval_modes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settings_id UUID NOT NULL REFERENCES project_skill_settings(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('prd', 'design_doc', 'design_prototype', 'test_case', 'adr')),
  mode TEXT NOT NULL CHECK (mode IN ('any_one', 'all_required')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (settings_id, document_type)
);

CREATE INDEX IF NOT EXISTS idx_project_approval_modes_settings
  ON project_approval_modes (settings_id);

-- Allow adr as a fifth document_type for individual project approvers.
ALTER TABLE project_approvers
  DROP CONSTRAINT IF EXISTS project_approvers_document_type_check;

ALTER TABLE project_approvers
  ADD CONSTRAINT project_approvers_document_type_check
  CHECK (document_type IN ('design_doc', 'prd', 'design_prototype', 'test_case', 'adr'));

-- Allow adr as a fifth document_type for project approver groups.
ALTER TABLE project_approver_groups
  DROP CONSTRAINT IF EXISTS project_approver_groups_document_type_check;

ALTER TABLE project_approver_groups
  ADD CONSTRAINT project_approver_groups_document_type_check
  CHECK (document_type IN ('design_doc', 'prd', 'design_prototype', 'test_case', 'adr'));

-- Cutover back-fill: every settings config gets one row per module. The four
-- pre-existing modules inherit the project-wide legacy mode; adr starts at
-- any_one. ON CONFLICT DO NOTHING makes this re-runnable and never overwrites a
-- mode a config already has.
INSERT INTO project_approval_modes (settings_id, document_type, mode)
SELECT
  s.id,
  m.document_type,
  CASE
    WHEN m.document_type = 'adr' THEN 'any_one'
    ELSE COALESCE(s.approval_mode, 'any_one')
  END
FROM project_skill_settings s
CROSS JOIN (
  VALUES ('prd'), ('design_doc'), ('design_prototype'), ('test_case'), ('adr')
) AS m(document_type)
ON CONFLICT (settings_id, document_type) DO NOTHING;

-- No adr rows are inserted into project_approvers / project_approver_groups:
-- existing projects intentionally start with an empty ADR pool, and no existing
-- pool row is read, updated, or deleted by this migration.

-- Down Migration

-- Dropping the additive table is lossless for approval mode: the legacy
-- project_skill_settings.approval_mode column is still the source of truth for
-- the older read path.
DROP TABLE IF EXISTS project_approval_modes;

-- Restoring the stricter pool constraints requires discarding any adr pool rows
-- configured after this migration, matching the rollback of the earlier
-- design_prototype and test_case widenings.
DELETE FROM project_approver_groups WHERE document_type = 'adr';
DELETE FROM project_approvers WHERE document_type = 'adr';

ALTER TABLE project_approver_groups
  DROP CONSTRAINT IF EXISTS project_approver_groups_document_type_check;

ALTER TABLE project_approver_groups
  ADD CONSTRAINT project_approver_groups_document_type_check
  CHECK (document_type IN ('design_doc', 'prd', 'design_prototype', 'test_case'));

ALTER TABLE project_approvers
  DROP CONSTRAINT IF EXISTS project_approvers_document_type_check;

ALTER TABLE project_approvers
  ADD CONSTRAINT project_approvers_document_type_check
  CHECK (document_type IN ('design_doc', 'prd', 'design_prototype', 'test_case'));
