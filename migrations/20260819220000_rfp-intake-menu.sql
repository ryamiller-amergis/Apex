-- Register the Apex-project RFP Intake menu key (permissions already seeded in
-- 20260819210000_rfp-intake-foundations.sql). Visibility remains Apex-only in the client.

-- Up Migration

UPDATE project_menu_settings
SET enabled_views = enabled_views || '["rfp-intake"]'::jsonb,
    updated_at = NOW()
WHERE project = 'Apex'
  AND NOT enabled_views @> '["rfp-intake"]'::jsonb;

-- Down Migration

UPDATE project_menu_settings
SET enabled_views = enabled_views - 'rfp-intake',
    updated_at = NOW()
WHERE project = 'Apex'
  AND enabled_views @> '["rfp-intake"]'::jsonb;
