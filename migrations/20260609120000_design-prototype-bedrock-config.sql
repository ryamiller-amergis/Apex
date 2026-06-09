-- Add per-project Bedrock model and max-token configuration for Design Prototype generation.
-- Defaults: model falls back to env/service default (BEDROCK_UI_MOCK_MODEL_ID);
-- max_tokens falls back to env/service default (BEDROCK_UI_MOCK_MAX_TOKENS).

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS design_prototype_bedrock_model_id text,
  ADD COLUMN IF NOT EXISTS design_prototype_bedrock_max_tokens integer;
