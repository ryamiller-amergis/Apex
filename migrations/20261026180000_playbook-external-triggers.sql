-- Up Migration
--
-- External Playbook triggers. The public id is unguessable. The secret verifies
-- an HMAC over the raw body. The project is the subscription's project.

ALTER TABLE playbook_trigger_subscriptions
  ADD COLUMN IF NOT EXISTS public_id text,
  ADD COLUMN IF NOT EXISTS webhook_secret text;

ALTER TABLE playbook_trigger_subscriptions
  DROP CONSTRAINT IF EXISTS playbook_trigger_subscriptions_kind_check;
ALTER TABLE playbook_trigger_subscriptions
  ADD CONSTRAINT playbook_trigger_subscriptions_kind_check
  CHECK (kind IN ('schedule', 'apex_event', 'webhook', 'azure_devops'));

ALTER TABLE playbook_trigger_subscriptions
  DROP CONSTRAINT IF EXISTS playbook_trigger_subscriptions_shape_check;
ALTER TABLE playbook_trigger_subscriptions
  ADD CONSTRAINT playbook_trigger_subscriptions_shape_check CHECK (
    (
      kind = 'schedule'
      AND schedule_hour BETWEEN 0 AND 23
      AND schedule_minute BETWEEN 0 AND 59
      AND event_type IS NULL
      AND public_id IS NULL
    )
    OR (
      kind = 'apex_event'
      AND event_type IS NOT NULL
      AND length(btrim(event_type)) > 0
      AND schedule_hour IS NULL
      AND schedule_minute IS NULL
      AND public_id IS NULL
    )
    OR (
      kind IN ('webhook', 'azure_devops')
      AND schedule_hour IS NULL
      AND schedule_minute IS NULL
      AND event_type IS NULL
      AND public_id IS NOT NULL
      AND length(btrim(public_id)) > 0
      AND webhook_secret IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_playbook_trigger_subscriptions_public_id
  ON playbook_trigger_subscriptions (public_id)
  WHERE public_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS uq_playbook_trigger_subscriptions_public_id;

ALTER TABLE playbook_trigger_subscriptions
  DROP CONSTRAINT IF EXISTS playbook_trigger_subscriptions_shape_check;
ALTER TABLE playbook_trigger_subscriptions
  ADD CONSTRAINT playbook_trigger_subscriptions_shape_check CHECK (
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
  );

ALTER TABLE playbook_trigger_subscriptions
  DROP CONSTRAINT IF EXISTS playbook_trigger_subscriptions_kind_check;
ALTER TABLE playbook_trigger_subscriptions
  ADD CONSTRAINT playbook_trigger_subscriptions_kind_check
  CHECK (kind IN ('schedule', 'apex_event'));

ALTER TABLE playbook_trigger_subscriptions
  DROP COLUMN IF EXISTS webhook_secret,
  DROP COLUMN IF EXISTS public_id;
