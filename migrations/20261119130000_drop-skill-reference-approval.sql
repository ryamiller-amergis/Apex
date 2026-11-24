-- Up Migration
-- A saved companion file is part of the skill. It does not wait for a second person.

ALTER TABLE project_playbook_skill_files
  DROP CONSTRAINT IF EXISTS project_playbook_skill_files_approval_check;

ALTER TABLE project_playbook_skill_files
  DROP COLUMN IF EXISTS approval_status;

UPDATE app_permissions
SET description = 'Read project skills and their files'
WHERE key = 'skills:view';

DELETE FROM app_role_permissions
WHERE permission_id IN (
  SELECT id FROM app_permissions WHERE key = 'skills:approve-reference'
);

DELETE FROM app_permissions WHERE key = 'skills:approve-reference';

-- Down Migration

ALTER TABLE project_playbook_skill_files
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved';

ALTER TABLE project_playbook_skill_files
  DROP CONSTRAINT IF EXISTS project_playbook_skill_files_approval_check;

ALTER TABLE project_playbook_skill_files
  ADD CONSTRAINT project_playbook_skill_files_approval_check
  CHECK (approval_status IN ('pending', 'approved'));

INSERT INTO app_permissions (key, description, category)
VALUES ('skills:approve-reference', 'Approve a reference file the person did not author', 'skills')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r
JOIN app_permissions p ON p.key = 'skills:approve-reference'
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

UPDATE app_permissions
SET description = 'Read project skills, instruction files, and reference-file names'
WHERE key = 'skills:view';
