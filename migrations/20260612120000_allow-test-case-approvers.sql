-- Up Migration

-- Allow test_case as a valid document_type for individual project approvers (QA reviewers).
ALTER TABLE project_approvers
  DROP CONSTRAINT IF EXISTS project_approvers_document_type_check;

ALTER TABLE project_approvers
  ADD CONSTRAINT project_approvers_document_type_check
  CHECK (document_type IN ('design_doc', 'prd', 'design_prototype', 'test_case'));

-- Allow test_case as a valid document_type for project approver groups.
ALTER TABLE project_approver_groups
  DROP CONSTRAINT IF EXISTS project_approver_groups_document_type_check;

ALTER TABLE project_approver_groups
  ADD CONSTRAINT project_approver_groups_document_type_check
  CHECK (document_type IN ('design_doc', 'prd', 'design_prototype', 'test_case'));

-- Down Migration

DELETE FROM project_approver_groups WHERE document_type = 'test_case';
DELETE FROM project_approvers WHERE document_type = 'test_case';

ALTER TABLE project_approver_groups
  DROP CONSTRAINT IF EXISTS project_approver_groups_document_type_check;

ALTER TABLE project_approver_groups
  ADD CONSTRAINT project_approver_groups_document_type_check
  CHECK (document_type IN ('design_doc', 'prd', 'design_prototype'));

ALTER TABLE project_approvers
  DROP CONSTRAINT IF EXISTS project_approvers_document_type_check;

ALTER TABLE project_approvers
  ADD CONSTRAINT project_approvers_document_type_check
  CHECK (document_type IN ('design_doc', 'prd', 'design_prototype'));
