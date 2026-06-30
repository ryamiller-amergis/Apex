-- Up Migration
ALTER TABLE dev_sessions ADD COLUMN IF NOT EXISTS pr_url text;

-- Down Migration
-- ALTER TABLE dev_sessions DROP COLUMN IF EXISTS pr_url;
