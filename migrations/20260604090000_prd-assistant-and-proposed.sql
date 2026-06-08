-- Up Migration

-- Alter prds table
ALTER TABLE prds ADD COLUMN IF NOT EXISTS prd_assistant_thread_id UUID;
ALTER TABLE prds ADD COLUMN IF NOT EXISTS proposed_content TEXT;
ALTER TABLE prds ADD COLUMN IF NOT EXISTS proposed_backlog_json JSONB;

-- Alter project_skill_settings table
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_assistant_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_assistant_model TEXT;

-- Down Migration
ALTER TABLE prds DROP COLUMN IF EXISTS prd_assistant_thread_id;
ALTER TABLE prds DROP COLUMN IF EXISTS proposed_content;
ALTER TABLE prds DROP COLUMN IF EXISTS proposed_backlog_json;

ALTER TABLE project_skill_settings DROP COLUMN IF EXISTS prd_assistant_skill_path;
ALTER TABLE project_skill_settings DROP COLUMN IF EXISTS prd_assistant_model;
