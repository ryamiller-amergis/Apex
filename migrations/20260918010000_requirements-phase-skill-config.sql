-- Up Migration: Requirements Phase skill configuration
-- Mirrors the Technical Phase columns so each project can point the
-- Requirements phase at its own skill, model, and effort.
-- All columns are nullable: existing settings keep the bundled skill.

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS requirements_phase_skill_path TEXT,
  ADD COLUMN IF NOT EXISTS requirements_phase_model TEXT,
  ADD COLUMN IF NOT EXISTS requirements_phase_effort TEXT;

-- Down Migration

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS requirements_phase_effort,
  DROP COLUMN IF EXISTS requirements_phase_model,
  DROP COLUMN IF EXISTS requirements_phase_skill_path;
