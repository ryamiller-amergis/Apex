-- Up Migration

-- Allow design_prototype as a valid document_type for individual project approvers,
-- matching the constraint already applied to project_approver_groups.
ALTER TABLE project_approvers
  DROP CONSTRAINT IF EXISTS project_approvers_document_type_check;

ALTER TABLE project_approvers
  ADD CONSTRAINT project_approvers_document_type_check
  CHECK (document_type IN ('design_doc', 'prd', 'design_prototype'));

-- Allow design_prototype in document_approver_assignments (per-document reviewer assignments).
ALTER TABLE document_approver_assignments
  DROP CONSTRAINT IF EXISTS document_approver_assignments_document_type_check;

ALTER TABLE document_approver_assignments
  ADD CONSTRAINT document_approver_assignments_document_type_check
  CHECK (document_type IN ('prd', 'design_doc', 'design_prototype'));

-- Down Migration

-- Remove any design_prototype rows before restoring the stricter constraints.
DELETE FROM document_approver_assignments WHERE document_type = 'design_prototype';
DELETE FROM project_approvers WHERE document_type = 'design_prototype';

ALTER TABLE document_approver_assignments
  DROP CONSTRAINT IF EXISTS document_approver_assignments_document_type_check;

ALTER TABLE document_approver_assignments
  ADD CONSTRAINT document_approver_assignments_document_type_check
  CHECK (document_type IN ('prd', 'design_doc'));

ALTER TABLE project_approvers
  DROP CONSTRAINT IF EXISTS project_approvers_document_type_check;

ALTER TABLE project_approvers
  ADD CONSTRAINT project_approvers_document_type_check
  CHECK (document_type IN ('design_doc', 'prd'));
