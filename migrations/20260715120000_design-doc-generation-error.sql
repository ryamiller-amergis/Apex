-- Up Migration
ALTER TABLE design_docs ADD COLUMN IF NOT EXISTS generation_error TEXT;

-- Down Migration
ALTER TABLE design_docs DROP COLUMN IF EXISTS generation_error;
