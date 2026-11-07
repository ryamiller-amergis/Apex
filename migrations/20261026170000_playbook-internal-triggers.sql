-- Up Migration
--
-- Internal Playbook triggers. A subscription starts an ordinary run. A receipt is the
-- idempotency boundary. External webhook and Azure DevOps kinds are not in this migration.

INSERT INTO app_permissions (id, key, description, category)
VALUES (
  gen_random_uuid(),
  'playbooks:triggers:manage',
  'Create, pause, and delete Playbook triggers',
  'playbooks'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin'
  AND p.key = 'playbooks:triggers:manage'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS playbook_trigger_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project text NOT NULL,
  definition_id uuid NOT NULL REFERENCES playbook_definitions(id) ON DELETE CASCADE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  kind text NOT NULL,
  schedule_hour integer,
  schedule_minute integer,
  event_type text,
  event_filter jsonb,
  version_policy text NOT NULL DEFAULT 'current_published',
  pinned_version_id uuid REFERENCES playbook_definition_versions(id) ON DELETE RESTRICT,
  initiator_user_id text NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  run_input_template jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_mapping jsonb NOT NULL DEFAULT '[]'::jsonb,
  concurrency_policy text NOT NULL DEFAULT 'skip_if_active',
  dedupe_key_template text NOT NULL,
  created_by text NOT NULL REFERENCES app_users(oid) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playbook_trigger_subscriptions_name_check CHECK (length(btrim(name)) > 0),
  CONSTRAINT playbook_trigger_subscriptions_kind_check CHECK (kind IN ('schedule', 'apex_event')),
  CONSTRAINT playbook_trigger_subscriptions_version_policy_check CHECK (version_policy IN ('current_published', 'pinned')),
  CONSTRAINT playbook_trigger_subscriptions_concurrency_check CHECK (concurrency_policy IN ('allow', 'skip_if_active')),
  CONSTRAINT playbook_trigger_subscriptions_shape_check CHECK (
    (
      kind = 'schedule'
      AND schedule_hour BETWEEN 0 AND 23
      AND schedule_minute BETWEEN 0 AND 59
      AND event_type IS NULL
    )
    OR (
      kind = 'apex_event'
      AND event_type IS NOT NULL
      AND length(btrim(event_type)) > 0
      AND schedule_hour IS NULL
      AND schedule_minute IS NULL
    )
  ),
  CONSTRAINT playbook_trigger_subscriptions_pin_check CHECK (
    (version_policy = 'current_published' AND pinned_version_id IS NULL)
    OR (version_policy = 'pinned' AND pinned_version_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_playbook_trigger_subscriptions_definition
  ON playbook_trigger_subscriptions (definition_id, enabled);
CREATE INDEX IF NOT EXISTS idx_playbook_trigger_subscriptions_schedule
  ON playbook_trigger_subscriptions (schedule_hour, schedule_minute)
  WHERE kind = 'schedule' AND enabled = true;

CREATE TABLE IF NOT EXISTS playbook_trigger_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES playbook_trigger_subscriptions(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  source text NOT NULL,
  payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,
  run_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playbook_trigger_receipts_status_check CHECK (
    status IN ('pending', 'started', 'skipped', 'retryable', 'failed', 'dead_letter')
  ),
  CONSTRAINT playbook_trigger_receipts_attempts_check CHECK (attempts >= 0),
  CONSTRAINT uq_playbook_trigger_receipts_idempotency UNIQUE (subscription_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_playbook_trigger_receipts_retry
  ON playbook_trigger_receipts (next_retry_at)
  WHERE status = 'retryable';

ALTER TABLE playbook_runs
  ADD COLUMN IF NOT EXISTS trigger_subscription_id uuid REFERENCES playbook_trigger_subscriptions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trigger_receipt_id uuid REFERENCES playbook_trigger_receipts(id) ON DELETE SET NULL;

ALTER TABLE playbook_trigger_receipts
  DROP CONSTRAINT IF EXISTS playbook_trigger_receipts_run_id_fkey;
ALTER TABLE playbook_trigger_receipts
  ADD CONSTRAINT playbook_trigger_receipts_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES playbook_runs(id) ON DELETE SET NULL;

-- Down Migration

ALTER TABLE playbook_trigger_receipts DROP CONSTRAINT IF EXISTS playbook_trigger_receipts_run_id_fkey;
ALTER TABLE playbook_runs
  DROP COLUMN IF EXISTS trigger_receipt_id,
  DROP COLUMN IF EXISTS trigger_subscription_id;
DROP TABLE IF EXISTS playbook_trigger_receipts;
DROP TABLE IF EXISTS playbook_trigger_subscriptions;

DELETE FROM app_role_permissions
WHERE permission_id IN (
  SELECT id FROM app_permissions WHERE key = 'playbooks:triggers:manage'
);
DELETE FROM app_permissions WHERE key = 'playbooks:triggers:manage';
