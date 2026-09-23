-- Task 7: durable interactive turn contracts and FIFO dispatch indexes.

-- Up Migration

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_transport_version_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_transport_version_check
  CHECK (
    transport_version IN (
      'http-files-v1',
      'servicebus-blob-v2',
      'dapr-actor-v2'
    )
  );

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS requested_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS interactive_class TEXT,
  ADD COLUMN IF NOT EXISTS client_turn_id UUID,
  ADD COLUMN IF NOT EXISTS client_turn_hash TEXT;

ALTER TABLE chat_message_attachments
  ADD COLUMN IF NOT EXISTS blob_ref JSONB,
  ADD COLUMN IF NOT EXISTS sha256 TEXT;

ALTER TABLE ai_run_attempts
  ADD COLUMN IF NOT EXISTS spec_snapshot JSONB;

UPDATE agent_runs
SET interactive_class = 'agentic'
WHERE lane = 'ai-runs-interactive'
  AND interactive_class IS NULL;

UPDATE agent_runs AS run
SET requested_by_user_id = thread.user_id
FROM chat_threads AS thread
WHERE run.lane = 'ai-runs-interactive'
  AND run.requested_by_user_id IS NULL
  AND run.thread_id = thread.id::text;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_interactive_class_check,
  DROP CONSTRAINT IF EXISTS agent_runs_client_turn_hash_check,
  DROP CONSTRAINT IF EXISTS agent_runs_dapr_actor_v2_required_fields_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_interactive_class_check
    CHECK (
      interactive_class IS NULL
      OR interactive_class IN ('fast', 'agentic')
    ),
  ADD CONSTRAINT agent_runs_client_turn_hash_check
    CHECK (
      client_turn_hash IS NULL
      OR client_turn_hash ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT agent_runs_dapr_actor_v2_required_fields_check
    CHECK (
      transport_version <> 'dapr-actor-v2'
      OR (
        requested_by_user_id IS NOT NULL
        AND interactive_class IS NOT NULL
        AND client_turn_id IS NOT NULL
        AND client_turn_hash IS NOT NULL
      )
    );

ALTER TABLE chat_message_attachments
  DROP CONSTRAINT IF EXISTS chat_message_attachments_sha256_check;

ALTER TABLE chat_message_attachments
  ADD CONSTRAINT chat_message_attachments_sha256_check
  CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE ai_run_attempts
  DROP CONSTRAINT IF EXISTS ai_run_attempts_failure_category_check;

ALTER TABLE ai_run_attempts
  ADD CONSTRAINT ai_run_attempts_failure_category_check
  CHECK (
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
      'internal_error',
      'hard_timeout',
      'tool_timeout',
      'worker_start_failed',
      'validation_failed'
    )
  );

DO $active_thread_guard$
DECLARE
  colliding_thread_ids TEXT;
BEGIN
  SELECT string_agg(thread_id, ', ' ORDER BY thread_id)
    INTO colliding_thread_ids
    FROM (
      SELECT thread_id
      FROM agent_runs
      WHERE lane = 'ai-runs-interactive'
        AND status IN ('queued', 'dispatched', 'running')
      GROUP BY thread_id
      HAVING COUNT(*) > 1
    ) AS collisions;

  IF colliding_thread_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot create uq_agent_runs_interactive_active_thread; colliding thread IDs: %',
      colliding_thread_ids;
  END IF;
END
$active_thread_guard$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_client_turn
  ON agent_runs (thread_id, client_turn_id)
  WHERE client_turn_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_interactive_active_thread
  ON agent_runs (thread_id)
  WHERE lane = 'ai-runs-interactive'
    AND status IN ('queued', 'dispatched', 'running');

CREATE INDEX IF NOT EXISTS idx_agent_runs_interactive_user_active
  ON agent_runs (requested_by_user_id, interactive_class, created_at)
  WHERE lane = 'ai-runs-interactive'
    AND status IN ('queued', 'dispatched', 'running');

CREATE INDEX IF NOT EXISTS idx_ai_run_outbox_interactive_due
  ON ai_run_outbox (created_at, id)
  WHERE kind = 'interactive_dispatch'
    AND published_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_run_outbox_interactive_class_due
  ON ai_run_outbox ((payload->>'interactiveClass'), created_at, id)
  WHERE kind = 'interactive_dispatch'
    AND published_at IS NULL;

-- Down Migration

DO $down_guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_runs WHERE transport_version = 'dapr-actor-v2'
  ) OR EXISTS (
    SELECT 1
      FROM ai_run_outbox
     WHERE kind = 'interactive_dispatch'
       AND published_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot remove durable interactive turn schema while dapr-actor-v2 data exists';
  END IF;
END
$down_guard$;

DROP INDEX IF EXISTS idx_ai_run_outbox_interactive_class_due;
DROP INDEX IF EXISTS idx_ai_run_outbox_interactive_due;
DROP INDEX IF EXISTS idx_agent_runs_interactive_user_active;
DROP INDEX IF EXISTS uq_agent_runs_interactive_active_thread;
DROP INDEX IF EXISTS uq_agent_runs_client_turn;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_dapr_actor_v2_required_fields_check,
  DROP CONSTRAINT IF EXISTS agent_runs_client_turn_hash_check,
  DROP CONSTRAINT IF EXISTS agent_runs_interactive_class_check,
  DROP CONSTRAINT IF EXISTS agent_runs_transport_version_check;

ALTER TABLE chat_message_attachments
  DROP CONSTRAINT IF EXISTS chat_message_attachments_sha256_check;

ALTER TABLE ai_run_attempts
  DROP CONSTRAINT IF EXISTS ai_run_attempts_failure_category_check;

ALTER TABLE ai_run_attempts
  ADD CONSTRAINT ai_run_attempts_failure_category_check
  CHECK (
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
  );

ALTER TABLE ai_run_attempts
  DROP COLUMN IF EXISTS spec_snapshot;

ALTER TABLE chat_message_attachments
  DROP COLUMN IF EXISTS blob_ref,
  DROP COLUMN IF EXISTS sha256;

ALTER TABLE agent_runs
  DROP COLUMN IF EXISTS requested_by_user_id,
  DROP COLUMN IF EXISTS interactive_class,
  DROP COLUMN IF EXISTS client_turn_id,
  DROP COLUMN IF EXISTS client_turn_hash;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_transport_version_check
  CHECK (transport_version IN ('http-files-v1', 'servicebus-blob-v2'));
