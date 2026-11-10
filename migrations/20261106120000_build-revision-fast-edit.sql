-- Durable provider-neutral fast revision attempts and ordered change sets.

-- Up Migration

CREATE TABLE build_revision_fast_edit_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  build_run_id UUID NOT NULL REFERENCES build_runs (id) ON DELETE RESTRICT,
  build_revision_id UUID NOT NULL REFERENCES build_revisions (id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  route TEXT,
  record_version INTEGER NOT NULL DEFAULT 1,
  base_commit TEXT NOT NULL,
  base_snapshot_ref TEXT NOT NULL,
  base_snapshot_digest TEXT NOT NULL,
  expected_workspace_version INTEGER NOT NULL,
  applied_workspace_version INTEGER,
  check_summary JSONB,
  agent_correlation_ref TEXT,
  failure_code TEXT,
  failure_message TEXT,
  requested_at TIMESTAMPTZ NOT NULL,
  preview_updated_at TIMESTAMPTZ,
  checks_completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT build_revision_fast_edit_attempts_status_check
    CHECK (status IN (
      'classify', 'edit', 'escalate', 'apply', 'checking',
      'ready', 'failed', 'rollback', 'superseded'
    )),
  CONSTRAINT build_revision_fast_edit_attempts_route_check
    CHECK (route IS NULL OR route IN ('fast_edit', 'full_build')),
  CONSTRAINT build_revision_fast_edit_attempts_request_digest_check
    CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT build_revision_fast_edit_attempts_base_commit_check
    CHECK (base_commit ~ '^[0-9a-f]{40}$'),
  CONSTRAINT build_revision_fast_edit_attempts_base_digest_check
    CHECK (base_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT build_revision_fast_edit_attempts_version_check
    CHECK (
      record_version >= 1
      AND expected_workspace_version >= 0
      AND (
        applied_workspace_version IS NULL
        OR applied_workspace_version >= expected_workspace_version
      )
    ),
  CONSTRAINT build_revision_fast_edit_attempts_check_summary_check
    CHECK (check_summary IS NULL OR jsonb_typeof(check_summary) = 'object'),
  CONSTRAINT build_revision_fast_edit_attempts_expiry_check
    CHECK (expires_at > requested_at)
);

CREATE UNIQUE INDEX uq_build_revision_fast_edit_attempt_idempotency
  ON build_revision_fast_edit_attempts (idempotency_key);
CREATE UNIQUE INDEX uq_build_revision_fast_edit_attempt_active_build
  ON build_revision_fast_edit_attempts (build_run_id)
  WHERE status IN ('classify', 'edit', 'apply', 'checking', 'rollback');
CREATE INDEX idx_build_revision_fast_edit_attempt_revision
  ON build_revision_fast_edit_attempts (build_revision_id, created_at);

CREATE TABLE build_revision_fast_edit_change_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL
    REFERENCES build_revision_fast_edit_attempts (id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  expected_workspace_version INTEGER NOT NULL,
  applied_workspace_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT build_revision_fast_edit_change_sets_sequence_check
    CHECK (sequence >= 1),
  CONSTRAINT build_revision_fast_edit_change_sets_kind_check
    CHECK (kind IN ('edit', 'rollback')),
  CONSTRAINT build_revision_fast_edit_change_sets_digest_check
    CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT build_revision_fast_edit_change_sets_workspace_version_check
    CHECK (
      expected_workspace_version >= 0
      AND applied_workspace_version = expected_workspace_version + 1
    )
);

CREATE UNIQUE INDEX uq_build_revision_fast_edit_change_set_sequence
  ON build_revision_fast_edit_change_sets (attempt_id, sequence);
CREATE UNIQUE INDEX uq_build_revision_fast_edit_change_set_idempotency
  ON build_revision_fast_edit_change_sets (idempotency_key);

-- Down Migration

DROP TABLE IF EXISTS build_revision_fast_edit_change_sets;
DROP TABLE IF EXISTS build_revision_fast_edit_attempts;
