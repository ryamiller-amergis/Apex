-- Up Migration
-- Daily Apex-scoped Bedrock billed totals from AWS Cost Explorer
-- (filtered by IAM principal cost-allocation tag Application=Apex).

CREATE TABLE IF NOT EXISTS bedrock_billing_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_date DATE NOT NULL,
  amount_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT NOT NULL UNIQUE,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bedrock_billing_daily_usage_date
  ON bedrock_billing_daily (usage_date DESC);

-- Down Migration
-- Forward-only for named prod apply (whole-file runner). Use a follow-up
-- migration to drop the table if rollback is ever required.
SELECT 1;
