-- Add quick_mcp_pills JSONB column to project_skill_settings
ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS quick_mcp_pills JSONB;
