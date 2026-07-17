-- Up Migration
ALTER TABLE adrs
  ADD COLUMN IF NOT EXISTS adr_assistant_thread_id UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposed_content TEXT;

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS adr_assistant_skill_path TEXT;

-- Down Migration
ALTER TABLE adrs
  DROP COLUMN IF EXISTS adr_assistant_thread_id,
  DROP COLUMN IF EXISTS proposed_content;

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS adr_assistant_skill_path;
