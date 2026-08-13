-- Up Migration
-- Allow walkthrough AI skills to use the Agent Skills canonical root while
-- retaining legacy Cursor and generic skill-path compatibility.

ALTER TABLE walkthrough_ai_options
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_generation_skill_path,
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_smart_tagging_skill_path,
  DROP CONSTRAINT IF EXISTS chk_walkthrough_ai_options_discovery_skill_path;

-- Rewrite previously legal but non-kebab skill-name segments (old CHECK used
-- [^/]+) so adding the tighter pattern cannot abort deploy on legacy rows.
CREATE OR REPLACE FUNCTION _apex_normalize_agent_skill_path(src TEXT, fallback TEXT)
RETURNS TEXT AS $$
DECLARE
  parts TEXT[];
  kebab TEXT;
BEGIN
  IF src IS NULL THEN
    RETURN fallback;
  END IF;
  IF src ~ '^(\.agents/skills|\.cursor/skills|skills)/[a-z0-9]+(-[a-z0-9]+)*/SKILL\.md$' THEN
    RETURN src;
  END IF;
  parts := regexp_match(src, '^(.*?)/([^/]+)/SKILL\.md$');
  IF parts IS NULL OR parts[1] NOT IN ('.agents/skills', '.cursor/skills', 'skills') THEN
    RETURN fallback;
  END IF;
  kebab := trim(both '-' FROM regexp_replace(lower(parts[2]), '[^a-z0-9]+', '-', 'g'));
  kebab := regexp_replace(kebab, '-+', '-', 'g');
  IF kebab = '' OR kebab !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RETURN fallback;
  END IF;
  RETURN parts[1] || '/' || kebab || '/SKILL.md';
END;
$$ LANGUAGE plpgsql;

UPDATE walkthrough_ai_options
SET
  walkthrough_generation_skill_path = _apex_normalize_agent_skill_path(
    walkthrough_generation_skill_path,
    '.cursor/skills/walkthrough-generation/SKILL.md'
  ),
  anchor_smart_tagging_skill_path = _apex_normalize_agent_skill_path(
    anchor_smart_tagging_skill_path,
    '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md'
  ),
  anchor_discovery_skill_path = _apex_normalize_agent_skill_path(
    anchor_discovery_skill_path,
    '.cursor/skills/walkthrough-anchor-discovery/SKILL.md'
  );

DROP FUNCTION _apex_normalize_agent_skill_path(TEXT, TEXT);

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
