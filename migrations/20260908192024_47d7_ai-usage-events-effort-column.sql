-- Up Migration
ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS effort TEXT;

-- Down Migration
ALTER TABLE ai_usage_events DROP COLUMN IF EXISTS effort;
