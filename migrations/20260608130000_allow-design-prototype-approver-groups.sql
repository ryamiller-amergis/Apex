-- Up Migration

-- Allow design_prototype as a valid document_type for project approver groups,
-- bringing prototype approvers to parity with PRD/design-doc (individuals + groups).
ALTER TABLE project_approver_groups
  DROP CONSTRAINT IF EXISTS project_approver_groups_document_type_check;

ALTER TABLE project_approver_groups
  ADD CONSTRAINT project_approver_groups_document_type_check
  CHECK (document_type IN ('design_doc', 'prd', 'design_prototype'));

-- Down Migration

-- Remove any design_prototype group references before restoring the stricter constraint.
DELETE FROM project_approver_groups WHERE document_type = 'design_prototype';

ALTER TABLE project_approver_groups
  DROP CONSTRAINT IF EXISTS project_approver_groups_document_type_check;

ALTER TABLE project_approver_groups
  ADD CONSTRAINT project_approver_groups_document_type_check
  CHECK (document_type IN ('design_doc', 'prd'));
