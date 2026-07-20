-- Up Migration
-- Greenfield app support (additive, non-breaking):
--   1. interview_web_research_enabled — opt-in flag; when true, interview threads for this
--      project get a relaxed scope carve-out permitting live web research.
--   2. interview_web_mcp — optional web-search MCP server config (QuickMcpPill shape) wired
--      into interview threads server-side when web research is enabled.
--   3. prototype_engine — which prototype generator this project uses:
--      'bedrock' (default, existing one-shot Bedrock path) or 'agent' (skill/agent flow).
-- All defaults preserve existing behavior for every current project.

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS interview_web_research_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS interview_web_mcp JSONB,
  ADD COLUMN IF NOT EXISTS prototype_engine VARCHAR(16) NOT NULL DEFAULT 'bedrock';

-- Down Migration

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS prototype_engine,
  DROP COLUMN IF EXISTS interview_web_mcp,
  DROP COLUMN IF EXISTS interview_web_research_enabled;
