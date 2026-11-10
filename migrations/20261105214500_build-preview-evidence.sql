-- Phase 2 live-preview evidence and revision-pinned rollout mode.

-- Up Migration

ALTER TABLE build_revisions
  ADD COLUMN preview_rollout_mode TEXT NOT NULL DEFAULT 'legacy_static',
  ADD CONSTRAINT build_revisions_preview_rollout_mode_check
    CHECK (preview_rollout_mode IN ('legacy_static', 'live'));

CREATE OR REPLACE FUNCTION build_revision_preview_mode_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.preview_rollout_mode IS DISTINCT FROM OLD.preview_rollout_mode THEN
    RAISE EXCEPTION 'preview rollout mode is write-once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER build_revision_preview_mode_guard
BEFORE UPDATE ON build_revisions
FOR EACH ROW
EXECUTE PROCEDURE build_revision_preview_mode_guard();

CREATE TABLE build_preview_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  build_revision_id UUID NOT NULL,
  commit TEXT NOT NULL,
  template_version TEXT NOT NULL,
  blob_ref JSONB NOT NULL,
  digest TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_build_preview_artifacts_revision
    FOREIGN KEY (build_revision_id) REFERENCES build_revisions (id) ON DELETE RESTRICT,
  CONSTRAINT build_preview_artifacts_commit_check
    CHECK (commit ~ '^[0-9a-f]{40}$'),
  CONSTRAINT build_preview_artifacts_template_version_check
    CHECK (char_length(btrim(template_version)) >= 1),
  CONSTRAINT build_preview_artifacts_blob_ref_check
    CHECK (jsonb_typeof(blob_ref) = 'object'),
  CONSTRAINT build_preview_artifacts_digest_check
    CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT build_preview_artifacts_size_check
    CHECK (size_bytes >= 0)
);

CREATE UNIQUE INDEX uq_build_preview_artifacts_revision
  ON build_preview_artifacts (build_revision_id);

CREATE TABLE build_preview_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  build_preview_artifact_id UUID NOT NULL,
  commit TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_handle TEXT,
  desired_state TEXT NOT NULL DEFAULT 'requested',
  state TEXT NOT NULL DEFAULT 'requested',
  last_operation_id TEXT,
  last_operation_kind TEXT,
  data_handle TEXT,
  route_handle TEXT,
  gateway_key_hash TEXT,
  readiness_status TEXT NOT NULL DEFAULT 'pending',
  readiness_checked_at TIMESTAMPTZ,
  failure_code TEXT,
  cleanup_state TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  last_reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_build_preview_instances_artifact
    FOREIGN KEY (build_preview_artifact_id) REFERENCES build_preview_artifacts (id) ON DELETE RESTRICT,
  CONSTRAINT build_preview_instances_commit_check
    CHECK (commit ~ '^[0-9a-f]{40}$'),
  CONSTRAINT build_preview_instances_digest_check
    CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT build_preview_instances_provider_check
    CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT build_preview_instances_desired_state_check
    CHECK (desired_state IN (
      'requested', 'provisioning', 'starting', 'verifying', 'ready', 'suspended',
      'terminating', 'terminated', 'failed', 'expired'
    )),
  CONSTRAINT build_preview_instances_state_check
    CHECK (state IN (
      'requested', 'provisioning', 'starting', 'verifying', 'ready', 'suspended',
      'terminating', 'terminated', 'failed', 'expired'
    )),
  CONSTRAINT build_preview_instances_operation_check
    CHECK (
      (last_operation_id IS NULL) = (last_operation_kind IS NULL)
      AND (last_operation_kind IS NULL OR last_operation_kind ~ '^[a-z][a-z0-9_]{0,31}$')
    ),
  CONSTRAINT build_preview_instances_readiness_status_check
    CHECK (readiness_status IN ('pending', 'passed', 'failed')),
  CONSTRAINT build_preview_instances_readiness_coherence_check
    CHECK (
      (readiness_status = 'pending') = (readiness_checked_at IS NULL)
      AND (state = 'ready') = (readiness_status = 'passed')
    ),
  CONSTRAINT build_preview_instances_failure_check
    CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT build_preview_instances_cleanup_state_check
    CHECK (cleanup_state IN ('pending', 'running', 'complete', 'failed')),
  CONSTRAINT build_preview_instances_expiry_check
    CHECK (expires_at > created_at)
);

CREATE INDEX idx_build_preview_instances_artifact_created
  ON build_preview_instances (build_preview_artifact_id, created_at DESC);
CREATE UNIQUE INDEX uq_build_preview_instances_provider_handle
  ON build_preview_instances (provider, provider_handle)
  WHERE provider_handle IS NOT NULL;
CREATE UNIQUE INDEX uq_build_preview_instances_gateway_key_hash
  ON build_preview_instances (gateway_key_hash)
  WHERE gateway_key_hash IS NOT NULL;
CREATE INDEX idx_build_preview_instances_expires
  ON build_preview_instances (expires_at)
  WHERE state NOT IN ('terminated', 'failed', 'expired');
CREATE INDEX idx_build_preview_instances_reconcile
  ON build_preview_instances (last_reconciled_at)
  WHERE state IN (
    'requested', 'provisioning', 'starting', 'verifying', 'ready', 'suspended', 'terminating'
  );

CREATE TABLE build_preview_browser_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  build_preview_instance_id UUID NOT NULL,
  commit TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  journey_version TEXT NOT NULL,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  console_summary JSONB,
  network_summary JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_build_preview_browser_checks_instance
    FOREIGN KEY (build_preview_instance_id) REFERENCES build_preview_instances (id) ON DELETE RESTRICT,
  CONSTRAINT build_preview_browser_checks_commit_check
    CHECK (commit ~ '^[0-9a-f]{40}$'),
  CONSTRAINT build_preview_browser_checks_digest_check
    CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT build_preview_browser_checks_status_check
    CHECK (status IN ('pending', 'passed', 'failed')),
  CONSTRAINT build_preview_browser_checks_journey_check
    CHECK (char_length(btrim(journey_version)) >= 1),
  CONSTRAINT build_preview_browser_checks_evidence_refs_check
    CHECK (jsonb_typeof(evidence_refs) = 'array'),
  CONSTRAINT build_preview_browser_checks_console_summary_check
    CHECK (console_summary IS NULL OR jsonb_typeof(console_summary) = 'object'),
  CONSTRAINT build_preview_browser_checks_network_summary_check
    CHECK (network_summary IS NULL OR jsonb_typeof(network_summary) = 'object'),
  CONSTRAINT build_preview_browser_checks_completion_check
    CHECK (
      (status = 'pending' AND started_at IS NULL AND completed_at IS NULL)
      OR (status IN ('passed', 'failed') AND started_at IS NOT NULL AND completed_at IS NOT NULL)
    )
);

CREATE INDEX idx_build_preview_browser_checks_instance_created
  ON build_preview_browser_checks (build_preview_instance_id, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS build_preview_browser_checks;
DROP TABLE IF EXISTS build_preview_instances;
DROP TABLE IF EXISTS build_preview_artifacts;
DROP TRIGGER IF EXISTS build_revision_preview_mode_guard ON build_revisions;
DROP FUNCTION IF EXISTS build_revision_preview_mode_guard();
ALTER TABLE build_revisions
  DROP CONSTRAINT IF EXISTS build_revisions_preview_rollout_mode_check,
  DROP COLUMN IF EXISTS preview_rollout_mode;
