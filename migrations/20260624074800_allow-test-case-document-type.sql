-- Allow 'test_case' as a document_type in document_approver_assignments
ALTER TABLE document_approver_assignments
  DROP CONSTRAINT document_approver_assignments_document_type_check;

ALTER TABLE document_approver_assignments
  ADD CONSTRAINT document_approver_assignments_document_type_check
  CHECK (document_type = ANY (ARRAY['prd'::text, 'design_doc'::text, 'design_prototype'::text, 'test_case'::text]));
