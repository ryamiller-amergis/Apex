-- Up Migration: complete the four-key Playbook permission catalog (TBI-036 / FEAT-009)
--
-- 20260919120300 created playbooks:view and playbooks:run for the Phase 0 spike, and
-- 20260922090000 widened their role grants for Phase 1. This migration finishes the catalog
-- without re-seeding or changing those grants: authoring remains an explicit assignment, while
-- project-wide administration belongs to admin by default.
--
-- `playbooks:run` is admission to start a run. It is deliberately not authority for each step's
-- effects; the step registry declares those permissions and execution re-checks them against the
-- initiator. Its old description also mentioned cancellation, which TBI-037 assigns instead to
-- the run initiator or a holder of playbooks:admin.
--
-- Idempotent — safe to re-run.

INSERT INTO app_permissions (key, description, category)
VALUES
  ('playbooks:author', 'Author, publish, and deprecate Playbook definitions', 'playbooks'),
  ('playbooks:admin',  'Administer Playbooks and cancel or retry any project run', 'playbooks')
ON CONFLICT (key) DO NOTHING;

UPDATE app_permissions
SET description = 'Start Playbook runs; does not authorize the run''s step effects'
WHERE key = 'playbooks:run';

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = 'admin'
  AND p.key = 'playbooks:admin'
ON CONFLICT DO NOTHING;

-- Down Migration
--
-- Restore exactly the Phase 1 state beneath this migration: widened view/run grants remain,
-- author/admin disappear, and playbooks:run gets its original Phase 0 description back.

DELETE FROM app_role_permissions
WHERE permission_id IN (
  SELECT id FROM app_permissions WHERE key IN ('playbooks:author', 'playbooks:admin')
);

DELETE FROM app_permissions WHERE key IN ('playbooks:author', 'playbooks:admin');

UPDATE app_permissions
SET description = 'Start and cancel Playbook runs'
WHERE key = 'playbooks:run';
