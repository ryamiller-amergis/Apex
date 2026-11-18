-- Up Migration
-- Prod Support is visible by default, so saved project menus gain the key.
-- The guided cloud-agent flags still hide the entry until rollout. Idempotent.

UPDATE project_menu_settings
SET enabled_views = enabled_views || '["prod-support"]'::jsonb,
    updated_at = NOW()
WHERE NOT enabled_views @> '["prod-support"]'::jsonb;

-- Down Migration

UPDATE project_menu_settings
SET enabled_views = enabled_views - 'prod-support',
    updated_at = NOW()
WHERE enabled_views @> '["prod-support"]'::jsonb;
