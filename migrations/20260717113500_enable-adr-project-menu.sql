UPDATE project_menu_settings
SET enabled_views = enabled_views || '["adr"]'::jsonb,
    updated_at = NOW()
WHERE NOT enabled_views @> '["adr"]'::jsonb;
