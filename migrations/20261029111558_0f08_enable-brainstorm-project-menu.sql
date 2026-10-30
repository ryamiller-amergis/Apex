-- Up Migration
-- FEAT-001 / TBI-002: Brainstorm is visible by default, so saved project menus gain the key.
-- The `brainstorm` feature flag still hides the entry until rollout. Idempotent.

UPDATE project_menu_settings
SET enabled_views = enabled_views || '["brainstorm"]'::jsonb,
    updated_at = NOW()
WHERE NOT enabled_views @> '["brainstorm"]'::jsonb;

-- Down Migration

UPDATE project_menu_settings
SET enabled_views = enabled_views - 'brainstorm',
    updated_at = NOW()
WHERE enabled_views @> '["brainstorm"]'::jsonb;
