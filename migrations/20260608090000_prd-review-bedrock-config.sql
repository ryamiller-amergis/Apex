-- Add per-project Bedrock model and max-token configuration for PRD Apex Review.
-- Defaults: model falls back to env/service default; max_tokens defaults to 16000.

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS prd_review_bedrock_model_id text,
  ADD COLUMN IF NOT EXISTS prd_review_bedrock_max_tokens integer;
