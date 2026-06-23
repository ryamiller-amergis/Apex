-- Remove Q&A interview stage columns.
-- design_docs: drop qa_chat_thread_id (the Q&A chat thread reference)
-- project_skill_settings: drop design_doc_qa_skill_path and design_doc_qa_model

ALTER TABLE design_docs
  DROP COLUMN IF EXISTS qa_chat_thread_id;

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS design_doc_qa_skill_path,
  DROP COLUMN IF EXISTS design_doc_qa_model;
