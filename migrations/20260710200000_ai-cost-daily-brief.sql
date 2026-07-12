-- Daily Executive Brief table for AI Cost Analytics
CREATE TABLE IF NOT EXISTS ai_cost_daily_brief (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  brief_date DATE NOT NULL,
  model_used TEXT NOT NULL,
  total_cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
  cursor_cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
  bedrock_cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
  total_interactions INTEGER NOT NULL DEFAULT 0,
  mtd_cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
  projected_eom_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
  trend_direction TEXT NOT NULL DEFAULT 'flat',
  trend_pct NUMERIC(8,4) NOT NULL DEFAULT 0,
  headline TEXT,
  key_bullets JSONB NOT NULL DEFAULT '[]',
  alerts JSONB NOT NULL DEFAULT '[]',
  top_features JSONB NOT NULL DEFAULT '[]',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project, brief_date)
);

CREATE INDEX IF NOT EXISTS idx_ai_cost_daily_brief_project_date ON ai_cost_daily_brief (project, brief_date DESC);
