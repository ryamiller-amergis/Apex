-- ── UI Lab Bedrock model configuration columns on project_skill_settings ──────
ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS ui_lab_bedrock_model_id         TEXT,
  ADD COLUMN IF NOT EXISTS ui_lab_bedrock_max_tokens       INTEGER,
  ADD COLUMN IF NOT EXISTS ui_lab_bedrock_timeout_ms       INTEGER,
  ADD COLUMN IF NOT EXISTS ui_lab_regen_bedrock_model_id   TEXT,
  ADD COLUMN IF NOT EXISTS ui_lab_regen_bedrock_max_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS ui_lab_bedrock_temperature      REAL,
  ADD COLUMN IF NOT EXISTS ui_lab_skill_path               TEXT;
