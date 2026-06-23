-- Per-project Bedrock timeout for design prototype generation.
-- When set, overrides the global MODEL_INVOKE_TIMEOUT_MS for prototype calls,
-- allowing admins to increase the timeout for projects with large EXTEND-mode pages.

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS design_prototype_bedrock_timeout_ms integer;
