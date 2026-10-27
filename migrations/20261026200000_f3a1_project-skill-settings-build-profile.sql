-- Up Migration
-- FEAT-003 / TBI-005: Build profile per repository configuration.
-- One JSONB unit plus its own audit columns, because updated_at and updated_by
-- also change on unrelated settings saves. Null means no profile yet.

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS build_profile jsonb,
  ADD COLUMN IF NOT EXISTS build_profile_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS build_profile_updated_by text;

ALTER TABLE project_skill_settings
  ADD CONSTRAINT project_skill_settings_build_profile_object_check
  CHECK (build_profile IS NULL OR jsonb_typeof(build_profile) = 'object');

COMMENT ON COLUMN project_skill_settings.build_profile IS
  'Build profile: roles (skill path, model), caps, quality manifest path, deploy pipeline id, support contact user ids.';

-- Down Migration

ALTER TABLE project_skill_settings
  DROP CONSTRAINT IF EXISTS project_skill_settings_build_profile_object_check;

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS build_profile_updated_by,
  DROP COLUMN IF EXISTS build_profile_updated_at,
  DROP COLUMN IF EXISTS build_profile;
