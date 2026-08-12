-- Up Migration
-- Allow walkthrough AI skills to use the Agent Skills canonical root while
-- retaining legacy Cursor and generic skill-path compatibility.

ALTER TABLE walkthrough_ai_options
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_generation_skill_path,
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_smart_tagging_skill_path,
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_discovery_skill_path;

ALTER TABLE walkthrough_ai_options
  ADD CONSTRAINT chk_walkthrough_ai_options_generation_skill_path
    CHECK (
      walkthrough_generation_skill_path ~
      '^(\.agents/skills|\.cursor/skills|skills)/[a-z0-9]+(-[a-z0-9]+)*/SKILL\.md$'
    ),
  ADD CONSTRAINT chk_walkthrough_ai_options_smart_tagging_skill_path
    CHECK (
      anchor_smart_tagging_skill_path ~
      '^(\.agents/skills|\.cursor/skills|skills)/[a-z0-9]+(-[a-z0-9]+)*/SKILL\.md$'
    ),
  ADD CONSTRAINT chk_walkthrough_ai_options_discovery_skill_path
    CHECK (
      anchor_discovery_skill_path ~
      '^(\.agents/skills|\.cursor/skills|skills)/[a-z0-9]+(-[a-z0-9]+)*/SKILL\.md$'
    );

-- Down Migration

ALTER TABLE walkthrough_ai_options
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_generation_skill_path,
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_smart_tagging_skill_path,
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_discovery_skill_path;

ALTER TABLE walkthrough_ai_options
  ADD CONSTRAINT chk_walkthrough_ai_options_generation_skill_path
    CHECK (
      walkthrough_generation_skill_path ~
      '^\.cursor/skills/[^/]+/SKILL\.md$'
    ),
  ADD CONSTRAINT chk_walkthrough_ai_options_smart_tagging_skill_path
    CHECK (
      anchor_smart_tagging_skill_path ~
      '^\.cursor/skills/[^/]+/SKILL\.md$'
    ),
  ADD CONSTRAINT chk_walkthrough_ai_options_discovery_skill_path
    CHECK (
      anchor_discovery_skill_path ~
      '^\.cursor/skills/[^/]+/SKILL\.md$'
    );
