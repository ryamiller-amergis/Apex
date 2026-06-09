-- Add per-project Bedrock model and max-token configuration specifically for
-- Design Prototype *regeneration* (revision) calls.
-- When set, regeneration uses this model instead of the generation model, allowing
-- a cheaper/faster model (e.g. Sonnet) for edit-pass tasks while keeping Opus for
-- the initial generation.
-- Defaults fall back to design_prototype_bedrock_model_id / env / service default.

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS design_prototype_regen_bedrock_model_id text,
  ADD COLUMN IF NOT EXISTS design_prototype_regen_bedrock_max_tokens integer;
