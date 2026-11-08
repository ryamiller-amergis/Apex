-- One AI Cost row per Cloud Agent run. Retries of the same completion must not double-count.

-- Up Migration

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_usage_events_cloud_agent_run
  ON ai_usage_events (run_id)
  WHERE feature = 'cloud-agent' AND run_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS uq_ai_usage_events_cloud_agent_run;
