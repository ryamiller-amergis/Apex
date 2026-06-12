-- Editable design plan step: one plan per PRD, generated cheaply before HTML prototypes.

CREATE TABLE design_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prd_id UUID NOT NULL UNIQUE REFERENCES prds(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'generating',
  version INTEGER NOT NULL DEFAULT 1,
  features JSONB NOT NULL DEFAULT '[]',
  backlog_hash TEXT,
  history JSONB NOT NULL DEFAULT '[]',
  generation_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_design_plans_status ON design_plans (status);

-- Per-project Bedrock model + max-token configuration for design plan generation.
-- Falls back to a low service default when unset (cheap JSON generation).
ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS design_plan_bedrock_model_id text,
  ADD COLUMN IF NOT EXISTS design_plan_bedrock_max_tokens integer;
