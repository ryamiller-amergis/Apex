-- Up Migration
-- Allow walkthrough AI skills to use the Agent Skills canonical root while
-- retaining legacy Cursor and generic skill-path compatibility.
-- Skill-name segments stay [^/]+ so existing stored paths are not rewritten.

ALTER TABLE walkthrough_ai_options
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_generation_skill_path,
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_smart_tagging_skill_path,
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_discovery_skill_path;

ALTER TABLE walkthrough_ai_options
  ADD CONSTRAINT chk_walkthrough_ai_options_generation_skill_path
    CHECK (
      walkthrough_generation_skill_path ~
      '^(\.agents/skills|\.cursor/skills|skills)/[^/]+/SKILL\.md$'
    ),
  ADD CONSTRAINT chk_walkthrough_ai_options_smart_tagging_skill_path
    CHECK (
      anchor_smart_tagging_skill_path ~
      '^(\.agents/skills|\.cursor/skills|skills)/[^/]+/SKILL\.md$'
    ),
  ADD CONSTRAINT chk_walkthrough_ai_options_discovery_skill_path
    CHECK (
      anchor_discovery_skill_path ~
      '^(\.agents/skills|\.cursor/skills|skills)/[^/]+/SKILL\.md$'
    );

-- Down Migration

ALTER TABLE walkthrough_ai_options
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_generation_skill_path,
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_smart_tagging_skill_path,
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_discovery_skill_path;

-- Revert non-legacy paths to column defaults so the old CHECK can be re-added.
UPDATE walkthrough_ai_options
SET walkthrough_generation_skill_path = '.cursor/skills/walkthrough-generation/SKILL.md'
WHERE walkthrough_generation_skill_path !~ '^\.cursor/skills/[^/]+/SKILL\.md$';

UPDATE walkthrough_ai_options
SET anchor_smart_tagging_skill_path = '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md'
WHERE anchor_smart_tagging_skill_path !~ '^\.cursor/skills/[^/]+/SKILL\.md$';

UPDATE walkthrough_ai_options
SET anchor_discovery_skill_path = '.cursor/skills/walkthrough-anchor-discovery/SKILL.md'
WHERE anchor_discovery_skill_path !~ '^\.cursor/skills/[^/]+/SKILL\.md$';

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
