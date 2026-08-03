-- Up Migration
-- Add Anchor discovery skill + agent model to Walkthroughs AI Options

ALTER TABLE walkthrough_ai_options
  ADD COLUMN IF NOT EXISTS anchor_discovery_skill_path TEXT NOT NULL
    DEFAULT '.cursor/skills/walkthrough-anchor-discovery/SKILL.md',
  ADD COLUMN IF NOT EXISTS anchor_discovery_model TEXT NOT NULL DEFAULT '';

ALTER TABLE walkthrough_ai_options
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_discovery_skill_path;

ALTER TABLE walkthrough_ai_options
  ADD CONSTRAINT chk_walkthrough_ai_options_discovery_skill_path
    CHECK (anchor_discovery_skill_path ~ '^\.cursor/skills/[^/]+/SKILL\.md$');

-- Down Migration
ALTER TABLE walkthrough_ai_options
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_discovery_skill_path;

ALTER TABLE walkthrough_ai_options
  DROP COLUMN IF EXISTS anchor_discovery_model,
  DROP COLUMN IF EXISTS anchor_discovery_skill_path;
