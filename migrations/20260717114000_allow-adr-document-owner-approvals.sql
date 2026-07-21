ALTER TABLE document_owner_approvals
  DROP CONSTRAINT IF EXISTS document_owner_approvals_document_type_check;

ALTER TABLE document_owner_approvals
  ADD CONSTRAINT document_owner_approvals_document_type_check
  CHECK (document_type IN ('prd', 'test_case', 'design_prototype', 'design_doc', 'adr'));
