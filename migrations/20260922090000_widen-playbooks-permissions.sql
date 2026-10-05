-- Up Migration: widen playbooks:view and playbooks:run to member and viewer (Phase 1)
--
-- 20260919120300 seeded both keys against `admin` alone and said why: Phase 0 was a default-off
-- internal spike, so least privilege then, "widened deliberately when the feature is real". This is
-- that widening. It lands at the start of Phase 1, when Playbooks first become something a person
-- other than their author is meant to reach.
--
-- The split follows the catalog's own convention rather than inventing one. `load-test:view` and
-- `load-test:run` are the closest analogue — view reaches viewer, run does not — and the reasoning
-- transfers exactly: reading what a run did is inert, whereas starting one spends AI budget and
-- writes to Azure DevOps and Teams through the step adapters.
--
-- This does not make Playbooks reachable on its own. The `playbooks-spike` flag still gates every
-- endpoint and every engine operation, so a role holding these keys in an environment where the
-- flag is off still gets a 404 from a router that does not exist there.
--
-- Idempotent — safe to re-run.

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member', 'viewer')
  AND p.key = 'playbooks:view'
ON CONFLICT DO NOTHING;

INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin', 'member')
  AND p.key = 'playbooks:run'
ON CONFLICT DO NOTHING;

-- Down Migration
--
-- Returns both keys to `admin` only, which is the state 20260919120300 left them in. Deliberately
-- narrower than deleting the grants outright: rolling this back should undo the widening, not the
-- seed beneath it.

DELETE FROM app_role_permissions
WHERE permission_id IN (SELECT id FROM app_permissions WHERE key IN ('playbooks:view', 'playbooks:run'))
  AND role_id IN (SELECT id FROM app_roles WHERE name IN ('member', 'viewer'));
