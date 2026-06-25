-- Up Migration: add nullable skill_settings_id to pipeline document tables

ALTER TABLE interviews ADD COLUMN skill_settings_id UUID;
ALTER TABLE prds ADD COLUMN skill_settings_id UUID;
ALTER TABLE design_docs ADD COLUMN skill_settings_id UUID;

-- Down Migration
-- ALTER TABLE interviews DROP COLUMN skill_settings_id;
-- ALTER TABLE prds DROP COLUMN skill_settings_id;
-- ALTER TABLE design_docs DROP COLUMN skill_settings_id;
