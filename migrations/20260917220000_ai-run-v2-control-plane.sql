-- Task 3: durable AI-run V2 control-plane tables and transport marker.
-- Additive and restart-safe. Does not rewrite existing agent_runs rows.

-- Up Migration

ALTER TABLE agent_runs
  ALTER COLUMN status SET DEFAULT 'queued';

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS transport_version TEXT NOT NULL DEFAULT 'http-files-v1';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_runs_transport_version_check'
  ) THEN
    ALTER TABLE agent_runs
      ADD CONSTRAINT agent_runs_transport_version_check
      CHECK (transport_version IN ('http-files-v1', 'servicebus-blob-v2'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_run_attempts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  dispatch_message_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  artifact_status TEXT NOT NULL DEFAULT 'pending',
  last_checkpoint_sequence INTEGER NOT NULL DEFAULT 0,
  last_checkpoint_at TIMESTAMPTZ,
  spec_ref JSONB,
  manifest_ref JSONB,
  failure_category TEXT,
  failure_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_run_attempts_run_number UNIQUE (run_id, attempt_number),
  CONSTRAINT uq_ai_run_attempts_dispatch_message_id UNIQUE (dispatch_message_id),
  CONSTRAINT ai_run_attempts_status_check CHECK (
    status IN (
      'queued',
      'dispatched',
      'running',
      'checking_worker',
      'finalizing',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  CONSTRAINT ai_run_attempts_artifact_status_check CHECK (
    artifact_status IN (
      'pending',
      'uploading',
      'manifest_written',
      'verified',
      'failed'
    )
  ),
  CONSTRAINT ai_run_attempts_failure_category_check CHECK (
    failure_category IS NULL
    OR failure_category IN (
      'worker_lost',
      'progress_timeout',
      'queue_ttl',
      'dispatch_ttl',
      'forced_cancel',
      'poison_message',
      'artifact_verification_failed',
      'lease_lost',
      'internal_error'
    )
  ),
  CONSTRAINT ai_run_attempts_attempt_number_check CHECK (attempt_number > 0),
  CONSTRAINT ai_run_attempts_checkpoint_sequence_check CHECK (last_checkpoint_sequence >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_run_attempts_active_run
  ON ai_run_attempts (run_id)
  WHERE status IN ('queued', 'dispatched', 'running', 'checking_worker', 'finalizing');

CREATE INDEX IF NOT EXISTS idx_ai_run_attempts_run_created
  ON ai_run_attempts (run_id, created_at);

CREATE TABLE IF NOT EXISTS ai_run_outbox (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT,
  payload JSONB NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  claim_expires_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_run_outbox_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT ai_run_outbox_publish_attempts_check CHECK (publish_attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ai_run_outbox_due
  ON ai_run_outbox (available_at, created_at)
  WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS ai_run_inbox (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  dispatch_message_id TEXT NOT NULL,
  checkpoint_sequence INTEGER,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT ai_run_inbox_checkpoint_sequence_check CHECK (
    checkpoint_sequence IS NULL OR checkpoint_sequence > 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_run_inbox_attempt_checkpoint
  ON ai_run_inbox (attempt_id, checkpoint_sequence)
  WHERE checkpoint_sequence IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_run_inbox_unprocessed
  ON ai_run_inbox (received_at)
  WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS ai_control_plane_leases (
  lease_key TEXT PRIMARY KEY,
  holder_id TEXT,
  fencing_token BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_control_plane_leases_key_check CHECK (
    lease_key IN ('admission', 'recovery', 'reaper', 'outbox')
  ),
  CONSTRAINT ai_control_plane_leases_fencing_token_check CHECK (fencing_token >= 0)
);

INSERT INTO ai_control_plane_leases (lease_key, holder_id, fencing_token, expires_at, updated_at)
VALUES
  ('admission', NULL, 0, 'epoch', now()),
  ('recovery', NULL, 0, 'epoch', now()),
  ('reaper', NULL, 0, 'epoch', now()),
  ('outbox', NULL, 0, 'epoch', now())
ON CONFLICT (lease_key) DO NOTHING;

-- Down Migration

DROP TABLE IF EXISTS ai_control_plane_leases;
DROP TABLE IF EXISTS ai_run_inbox;
DROP TABLE IF EXISTS ai_run_outbox;
DROP TABLE IF EXISTS ai_run_attempts;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_transport_version_check;

ALTER TABLE agent_runs
  DROP COLUMN IF EXISTS transport_version;

ALTER TABLE agent_runs
  ALTER COLUMN status SET DEFAULT 'running';
