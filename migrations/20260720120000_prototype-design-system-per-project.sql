-- Up Migration
-- Per-project prototype design system support:
--   1. prototype_design_system_path — path (within the project's own repo) to the design-system
--      skill file that drives Bedrock prototype generation. Defaults to the convention path
--      .cursor/skills/design-system/SKILL.md when null.
--   2. screen_inventory_path — optional path (within the project's repo) to a screen-inventory
--      markdown file used in EXTEND mode. When null, EXTEND falls back gracefully.
--   3. prototype_web_references_enabled — per-project toggle that enables a live Tavily web
--      design-reference step injected into NEW-page prototype generation. Default off.
-- All defaults preserve existing behavior: APEX falls back to the bundled MaxView design system
-- during the transition while each project migrates its design system into its own repo.

ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS prototype_design_system_path TEXT,
  ADD COLUMN IF NOT EXISTS screen_inventory_path TEXT,
  ADD COLUMN IF NOT EXISTS prototype_web_references_enabled BOOLEAN NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS prototype_web_references_enabled,
  DROP COLUMN IF EXISTS screen_inventory_path,
  DROP COLUMN IF EXISTS prototype_design_system_path;
