ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_doc_assistant_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_doc_assistant_model TEXT;
ALTER TABLE design_docs ADD COLUMN IF NOT EXISTS doc_assistant_thread_id UUID;
