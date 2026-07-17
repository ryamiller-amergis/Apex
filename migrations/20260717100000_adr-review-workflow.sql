ALTER TABLE adrs
  ADD COLUMN IF NOT EXISTS reviewer_ids JSONB,
  ADD COLUMN IF NOT EXISTS fix_comment_id UUID;

INSERT INTO app_permissions (key, category, description)
VALUES ('adr:review', 'adr', 'Review and comment on architecture decision records')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member')
  AND p.key = 'adr:review'
ON CONFLICT DO NOTHING;
