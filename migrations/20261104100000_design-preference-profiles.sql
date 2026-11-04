-- Up Migration
-- Per-repository design preference profile with user-approved proposals only.

CREATE TABLE IF NOT EXISTS project_design_preference_profiles (
  settings_id uuid PRIMARY KEY REFERENCES project_skill_settings(id) ON DELETE CASCADE,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

ALTER TABLE project_design_preference_profiles
  ADD CONSTRAINT project_design_preference_profiles_object_check
  CHECK (jsonb_typeof(profile) = 'object');

CREATE TABLE IF NOT EXISTS project_design_preference_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settings_id uuid NOT NULL REFERENCES project_skill_settings(id) ON DELETE CASCADE,
  proposed_profile jsonb NOT NULL,
  source text NOT NULL,
  source_ref text,
  feedback_excerpt text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  decided_at timestamptz,
  decided_by text
);

ALTER TABLE project_design_preference_proposals
  ADD CONSTRAINT project_design_preference_proposals_object_check
  CHECK (jsonb_typeof(proposed_profile) = 'object');

ALTER TABLE project_design_preference_proposals
  ADD CONSTRAINT project_design_preference_proposals_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'superseded'));

CREATE INDEX IF NOT EXISTS project_design_preference_proposals_settings_status_idx
  ON project_design_preference_proposals (settings_id, status);

-- Down Migration

DROP INDEX IF EXISTS project_design_preference_proposals_settings_status_idx;

ALTER TABLE project_design_preference_proposals
  DROP CONSTRAINT IF EXISTS project_design_preference_proposals_status_check;

ALTER TABLE project_design_preference_proposals
  DROP CONSTRAINT IF EXISTS project_design_preference_proposals_object_check;

DROP TABLE IF EXISTS project_design_preference_proposals;

ALTER TABLE project_design_preference_profiles
  DROP CONSTRAINT IF EXISTS project_design_preference_profiles_object_check;

DROP TABLE IF EXISTS project_design_preference_profiles;
