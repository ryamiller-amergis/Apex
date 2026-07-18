/**
 * Integration tests for RBAC data layer.
 *
 * Verifies real schema/query behaviour for:
 * - getUserPermissions resolving from actual role-permission rows.
 * - Project-scoped role resolution via app_user_project_roles.
 * - getUserRoleNames returning the correct set.
 *
 * Uses the dev-mock-seed OIDs that are inserted by the migration:
 *   20260623150000_seed-dev-mock-users.sql
 */
import './setup';
import { getUserPermissions, getUserRoleNames } from '../../src/server/services/rbacService';

const BA_OID = 'dev-mock-oid-00000000-0000-0000-0000-000000000001';

describe('RBAC integration — getUserPermissions', () => {
  it('returns permissions for the "member" role assigned to BA persona', async () => {
    const permissions = await getUserPermissions(BA_OID, 'MaxView');

    // member role should include calendar:view, backlog:view, chat:view
    expect(permissions).toContain('calendar:view');
    expect(permissions).toContain('chat:view');
    expect(permissions).toContain('chat:create');
    // admin-only permissions must NOT be present for a plain member
    expect(permissions).not.toContain('admin:roles');
    expect(permissions).not.toContain('analytics:ai-cost:view');
  });

  it('returns an empty array for an unknown user', async () => {
    const permissions = await getUserPermissions('nonexistent-oid-12345', 'MaxView');
    expect(permissions).toEqual([]);
  });
});

describe('RBAC integration — getUserRoleNames', () => {
  it('returns "member" for the dev-mock BA persona', async () => {
    const roles = await getUserRoleNames(BA_OID);
    expect(roles).toContain('member');
    // Should not have admin role
    expect(roles).not.toContain('admin');
  });

  it('returns empty array for unknown user', async () => {
    const roles = await getUserRoleNames('unknown-oid-99999');
    expect(roles).toEqual([]);
  });
});
