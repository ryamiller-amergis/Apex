ALTER TABLE document_approver_assignments
  DROP CONSTRAINT IF EXISTS document_approver_assignments_document_type_check;

ALTER TABLE document_approver_assignments
  ADD CONSTRAINT document_approver_assignments_document_type_check
  CHECK (document_type IN ('prd', 'design_doc', 'design_prototype', 'test_case', 'adr'));
