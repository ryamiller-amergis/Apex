-- Add analytics:ai-cost:view permission (admin role only)
INSERT INTO app_permissions (key, category, description)
VALUES ('analytics:ai-cost:view', 'analytics', 'View AI cost analytics for the project')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin'
  AND p.key = 'analytics:ai-cost:view'
ON CONFLICT DO NOTHING;

-- Add dev-workbench permission not added here (already exists)

-- AI Pricing catalog
CREATE TABLE IF NOT EXISTS ai_pricing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_price_per_mtok NUMERIC(14,8) NOT NULL DEFAULT 0,
  output_price_per_mtok NUMERIC(14,8) NOT NULL DEFAULT 0,
  cache_read_price_per_mtok NUMERIC(14,8) NOT NULL DEFAULT 0,
  cache_write_price_per_mtok NUMERIC(14,8) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, model_id, effective_from)
);

-- Seed public Anthropic Bedrock pricing (per 1M tokens, USD, as of Jul 2026)
INSERT INTO ai_pricing (provider, model_id, input_price_per_mtok, output_price_per_mtok, cache_read_price_per_mtok, cache_write_price_per_mtok, effective_from)
VALUES
  ('bedrock', 'us.anthropic.claude-opus-4-8',               15.00,  75.00,  1.50,  18.75, '2026-01-01'),
  ('bedrock', 'us.anthropic.claude-opus-4-6-v1',            15.00,  75.00,  1.50,  18.75, '2026-01-01'),
  ('bedrock', 'us.anthropic.claude-sonnet-4-6',              3.00,  15.00,  0.30,   3.75, '2026-01-01'),
  ('bedrock', 'us.anthropic.claude-sonnet-4-5-20251001-v1:0',3.00,  15.00,  0.30,   3.75, '2026-01-01'),
  ('bedrock', 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 0.80,   4.00,  0.08,   1.00, '2026-01-01'),
  ('bedrock', 'us.anthropic.claude-opus-4-5-20251001-v1:0', 15.00,  75.00,  1.50,  18.75, '2026-01-01'),
  ('bedrock', 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',3.00,  15.00,  0.30,   3.75, '2026-01-01'),
  ('bedrock', 'us.anthropic.claude-3-5-haiku-20241022-v1:0', 0.80,   4.00,  0.08,   1.00, '2026-01-01')
ON CONFLICT (provider, model_id, effective_from) DO NOTHING;

-- Cursor models (token-based — chargedCents is authoritative; these are fallback estimates)
INSERT INTO ai_pricing (provider, model_id, input_price_per_mtok, output_price_per_mtok, cache_read_price_per_mtok, cache_write_price_per_mtok, effective_from)
VALUES
  ('cursor', 'claude-opus-4-6',   15.00, 75.00, 1.50, 18.75, '2026-01-01'),
  ('cursor', 'claude-sonnet-4-6',  3.00, 15.00, 0.30,  3.75, '2026-01-01'),
  ('cursor', 'gpt-5.5',            2.50, 10.00, 0.25,  3.00, '2026-01-01'),
  ('cursor', 'gemini-3.1-pro',     1.25,  5.00, 0.13,  1.25, '2026-01-01'),
  ('cursor', 'composer-2',         1.00,  4.00, 0.10,  1.00, '2026-01-01'),
  ('cursor', 'composer-2.5',       1.00,  4.00, 0.10,  1.00, '2026-01-01')
ON CONFLICT (provider, model_id, effective_from) DO NOTHING;

-- AI Usage Events (our per-call attribution ledger)
CREATE TABLE IF NOT EXISTS ai_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  project TEXT NOT NULL,
  skill_path TEXT,
  thread_id TEXT,
  run_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  work_item_id TEXT,
  user_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  token_source TEXT NOT NULL DEFAULT 'estimated' CHECK (token_source IN ('exact', 'estimated')),
  cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
  cost_source TEXT NOT NULL DEFAULT 'estimated' CHECK (cost_source IN ('computed', 'estimated', 'allocated')),
  duration_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_created_at ON ai_usage_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_provider ON ai_usage_events (provider);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_project ON ai_usage_events (project);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_feature ON ai_usage_events (feature);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_model ON ai_usage_events (model_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_project_created ON ai_usage_events (project, created_at DESC);

-- Cursor authoritative billing mirror
CREATE TABLE IF NOT EXISTS cursor_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts TIMESTAMPTZ NOT NULL,
  service_account_id TEXT,
  project TEXT,
  model TEXT NOT NULL,
  kind TEXT,
  max_mode BOOLEAN NOT NULL DEFAULT FALSE,
  is_headless BOOLEAN NOT NULL DEFAULT FALSE,
  is_token_based_call BOOLEAN NOT NULL DEFAULT FALSE,
  is_chargeable BOOLEAN NOT NULL DEFAULT FALSE,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_write_tokens INTEGER,
  cache_read_tokens INTEGER,
  total_model_cents NUMERIC(14,8),
  charged_cents NUMERIC(14,8) NOT NULL DEFAULT 0,
  cursor_token_fee_cents NUMERIC(14,8),
  requests_costs NUMERIC(14,8),
  user_email TEXT,
  dedupe_key TEXT UNIQUE,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cursor_usage_events_ts ON cursor_usage_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_cursor_usage_events_sa ON cursor_usage_events (service_account_id);
CREATE INDEX IF NOT EXISTS idx_cursor_usage_events_project ON cursor_usage_events (project);
CREATE INDEX IF NOT EXISTS idx_cursor_usage_events_model ON cursor_usage_events (model);

-- AI Cost Insights cache
CREATE TABLE IF NOT EXISTS ai_cost_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  model_used TEXT NOT NULL,
  headline TEXT,
  insights JSONB NOT NULL DEFAULT '[]',
  recommendations JSONB NOT NULL DEFAULT '[]',
  risk_flags JSONB NOT NULL DEFAULT '[]',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project, period_from, period_to)
);

-- Add nullable Cursor SA columns to project_skill_settings
ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS cursor_api_key_env_ref TEXT,
  ADD COLUMN IF NOT EXISTS cursor_service_account_id TEXT;
