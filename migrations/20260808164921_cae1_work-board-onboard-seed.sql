-- Up Migration: Work Board onboarding — enable menu visibility for existing projects
--
-- Menu visibility is stored in project_menu_settings.enabled_views (JSONB array of
-- MenuItemKey strings). See src/shared/types/menuSettings.ts and
-- src/server/services/menuSettingsService.ts.
--
-- Projects WITHOUT a project_menu_settings row already pick up 'work-board' from
-- DEFAULT_ENABLED_MENU_VIEWS (all configurable keys except opt-in 'diagrams').
-- This migration only appends 'work-board' to existing rows that lack it so
-- Platform Admin configs do not hide the new view after rollout.
--
-- Intentionally non-destructive: no project rows are inserted, and no other
-- menu keys are removed or reordered.

UPDATE project_menu_settings
SET enabled_views = enabled_views || '["work-board"]'::jsonb,
    updated_at = NOW()
WHERE NOT enabled_views @> '["work-board"]'::jsonb;

-- Down Migration
-- Removing 'work-board' from existing configs is not reversed automatically
-- (operators may have enabled it intentionally after rollout).
