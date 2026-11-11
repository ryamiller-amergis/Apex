-- Up Migration

-- Event-driven triggers (Azure DevOps, webhook, Apex event) start one run per delivery, so two
-- deliveries run at the same time. Schedule triggers keep skipping a tick while a run is live.
-- Idempotent.
UPDATE playbook_trigger_subscriptions
SET concurrency_policy = 'allow',
    updated_at = now()
WHERE kind <> 'schedule'
  AND concurrency_policy <> 'allow';

-- Down Migration

-- No-op. The previous value is not recorded, and 'allow' is a valid value under the old code.
SELECT 1;
