-- Up Migration
-- FEAT-003: columns and constraints the artifact version store and the handoff
-- engine need on the FEAT-001 Brainstorm tables.

-- An artifact row exists only after the first write, and a first draft has no type.
ALTER TABLE brainstorm_artifacts ALTER COLUMN artifact_type DROP NOT NULL;
ALTER TABLE brainstorm_artifacts
  ADD CONSTRAINT brainstorm_artifacts_type_check CHECK (
    artifact_type IS NULL OR artifact_type IN ('adr', 'technical_design', 'implementation_plan', 'discovery_brief')
  );

-- The type at each version, so a rollback across a type switch restores it, and the
-- run that wrote an AI change, so a second change in the same turn uses that version.
ALTER TABLE brainstorm_artifact_versions ADD COLUMN IF NOT EXISTS artifact_type text;
ALTER TABLE brainstorm_artifact_versions ADD COLUMN IF NOT EXISTS run_id uuid;
ALTER TABLE brainstorm_artifact_versions
  ADD CONSTRAINT brainstorm_artifact_versions_origin_check CHECK (
    change_origin IN ('ai_change', 'type_switch', 'rollback')
  );
ALTER TABLE brainstorm_artifact_versions
  ADD CONSTRAINT brainstorm_artifact_versions_checkpoint_length_check CHECK (
    checkpoint_name IS NULL OR char_length(checkpoint_name) BETWEEN 1 AND 80
  );
CREATE UNIQUE INDEX IF NOT EXISTS uq_brainstorm_artifact_versions_checkpoint
  ON brainstorm_artifact_versions (artifact_id, lower(checkpoint_name))
  WHERE checkpoint_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_brainstorm_artifact_versions_run
  ON brainstorm_artifact_versions (artifact_id, run_id)
  WHERE run_id IS NOT NULL;

-- Why the turn's artifact change failed. The chat reply itself can still complete.
ALTER TABLE brainstorm_messages ADD COLUMN IF NOT EXISTS artifact_failure_code text;

-- Handoff rows: the version they bind to, the reserved target thread used to find an
-- interrupted target record, the claim token and the stored refusal.
ALTER TABLE brainstorm_actions ADD COLUMN IF NOT EXISTS artifact_version integer;
ALTER TABLE brainstorm_actions ADD COLUMN IF NOT EXISTS target_thread_id uuid;
ALTER TABLE brainstorm_actions ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE brainstorm_actions ADD COLUMN IF NOT EXISTS failure_code text;
ALTER TABLE brainstorm_actions
  ADD CONSTRAINT brainstorm_actions_state_check CHECK (
    state IN ('previewed', 'executing', 'completed', 'failed')
  );
ALTER TABLE brainstorm_actions
  ADD CONSTRAINT brainstorm_actions_kind_check CHECK (
    action_kind IN ('keep_standalone', 'start_workflow', 'create_direct')
  );
CREATE UNIQUE INDEX IF NOT EXISTS uq_brainstorm_actions_live_per_version
  ON brainstorm_actions (session_id, action_kind, artifact_version)
  WHERE state <> 'failed';

-- Down Migration

DROP INDEX IF EXISTS uq_brainstorm_actions_live_per_version;
ALTER TABLE brainstorm_actions DROP CONSTRAINT IF EXISTS brainstorm_actions_kind_check;
ALTER TABLE brainstorm_actions DROP CONSTRAINT IF EXISTS brainstorm_actions_state_check;
ALTER TABLE brainstorm_actions DROP COLUMN IF EXISTS failure_code;
ALTER TABLE brainstorm_actions DROP COLUMN IF EXISTS claim_token;
ALTER TABLE brainstorm_actions DROP COLUMN IF EXISTS target_thread_id;
ALTER TABLE brainstorm_actions DROP COLUMN IF EXISTS artifact_version;
ALTER TABLE brainstorm_messages DROP COLUMN IF EXISTS artifact_failure_code;
DROP INDEX IF EXISTS idx_brainstorm_artifact_versions_run;
DROP INDEX IF EXISTS uq_brainstorm_artifact_versions_checkpoint;
ALTER TABLE brainstorm_artifact_versions DROP CONSTRAINT IF EXISTS brainstorm_artifact_versions_checkpoint_length_check;
ALTER TABLE brainstorm_artifact_versions DROP CONSTRAINT IF EXISTS brainstorm_artifact_versions_origin_check;
ALTER TABLE brainstorm_artifact_versions DROP COLUMN IF EXISTS run_id;
ALTER TABLE brainstorm_artifact_versions DROP COLUMN IF EXISTS artifact_type;
ALTER TABLE brainstorm_artifacts DROP CONSTRAINT IF EXISTS brainstorm_artifacts_type_check;
UPDATE brainstorm_artifacts SET artifact_type = 'discovery_brief' WHERE artifact_type IS NULL;
ALTER TABLE brainstorm_artifacts ALTER COLUMN artifact_type SET NOT NULL;
