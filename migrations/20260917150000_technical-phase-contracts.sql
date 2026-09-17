-- Up Migration: FEAT-005 Wave 1 Bundle A (S1)
-- Technical Phase skill configuration is independent from technical analysis.
-- All columns are nullable so existing settings and interviews remain unchanged.

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS technical_phase_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS technical_phase_model TEXT,
  ADD COLUMN IF NOT EXISTS technical_phase_effort TEXT;

ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS technical_phase_chat_thread_id UUID
    REFERENCES chat_threads(id) ON DELETE SET NULL;

-- Down Migration

ALTER TABLE interviews
  DROP COLUMN IF EXISTS technical_phase_chat_thread_id;

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS technical_phase_effort,
  DROP COLUMN IF EXISTS technical_phase_model,
  DROP COLUMN IF EXISTS technical_phase_skill_path;
