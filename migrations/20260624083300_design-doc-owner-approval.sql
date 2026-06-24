-- Allow 'design_doc' as a document_type in document_owner_approvals
ALTER TABLE document_owner_approvals
  DROP CONSTRAINT document_owner_approvals_document_type_check;

ALTER TABLE document_owner_approvals
  ADD CONSTRAINT document_owner_approvals_document_type_check
  CHECK (document_type IN ('prd', 'test_case', 'design_prototype', 'design_doc'));
