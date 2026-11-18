-- Up Migration
-- SHA-256 of the SKILL.md content an agent loaded. chat_threads holds the skill loaded
-- most recently (an Interview loads a different skill per phase). prds and design_docs
-- hold the skill that produced the saved content. NULL for rows saved before this column.

ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS skill_sha256 TEXT;
ALTER TABLE prds ADD COLUMN IF NOT EXISTS skill_sha256 TEXT;
ALTER TABLE design_docs ADD COLUMN IF NOT EXISTS skill_sha256 TEXT;

-- Down Migration

ALTER TABLE design_docs DROP COLUMN IF EXISTS skill_sha256;
ALTER TABLE prds DROP COLUMN IF EXISTS skill_sha256;
ALTER TABLE chat_threads DROP COLUMN IF EXISTS skill_sha256;
