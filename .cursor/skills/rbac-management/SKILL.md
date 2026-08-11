---
name: rbac-management
description: Manage RBAC permissions in this project -- add, remove, or modify permission keys, role assignments, server middleware gating, and client-side can() guards. Use when the rbac-governance rule determines RBAC work is required, or when the user explicitly asks to add/remove a permission, update role access, or wire access control to a new feature.
disable-model-invocation: true
---

# RBAC Management

This skill is loaded when the `rbac-governance` rule determines that an add, remove, or modify operation is needed on the RBAC layer. Follow the appropriate workflow below.

---

## Permission Catalog (source of truth: `migrations/1778778800000_rbac-tables.sql`)

| Key | Category | Description | admin | member | viewer |
|-----|----------|-------------|-------|--------|--------|
| `admin:roles` | admin | Manage roles and permissions | ✓ | | |
| `admin:users` | admin | Manage user role assignments | ✓ | | |
| `api-keys:manage` | api-keys | Create, view, update, regenerate, and delete project API keys | ✓ | | |
| `backlog:view` | backlog | View backlog page | ✓ | ✓ | |
| `calendar:view` | calendar | View calendar page | ✓ | ✓ | |
| `chat:create` | chat | Create new chat threads | ✓ | ✓ | |
| `chat:view` | chat | Access Agent Studio chat | ✓ | ✓ | |
| `chat:view_all` | chat | View all users' chat threads | ✓ | | |
| `home:view` | chat | Access the Agent Home page | ✓ | ✓ | ✓ |
| `cost:view` | cost | View cost and usage data | ✓ | | ✓ |
| `diagram:view` | diagram | View owned and shared Diagrams | ✓ | ✓ | ✓ |
| `diagram:create` | diagram | Create Diagrams | ✓ | ✓ | |
| `diagram:edit` | diagram | Edit owned or editable shared Diagrams | ✓ | ✓ | |
| `diagram:delete` | diagram | Delete owned Diagrams | ✓ | ✓ | |
| `diagram:share` | diagram | Manage shares for owned Diagrams | ✓ | ✓ | |
| `deployments:create` | deployments | Create deployments | ✓ | ✓ | |
| `deployments:manage` | deployments | Manage existing deployments | ✓ | | |
| `planning:view` | planning | View planning analytics pages | ✓ | ✓ | ✓ |
| `skills:manage` | skills | Manage agent skills | ✓ | | |
| `wiki:write` | wiki | Create and edit wiki pages | ✓ | ✓ | |
| `workitems:write` | workitems | Create and edit work items | ✓ | ✓ | |

**Roles:** `admin` (all permissions), `member` (default role — create/write subset), `viewer` (read-only subset).

---

## Workflow A: Adding a New Permission

### 1. Create the migration

```bash
npm run migrate:create -- add-<category>-<name>-permission
```

In the generated SQL file:

```sql
-- Up Migration
INSERT INTO app_permissions (id, key, description, category) VALUES
  (gen_random_uuid(), '<category>:<name>', '<Human description>', '<category>');

-- Wire to roles (adjust which roles should have it)
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name IN ('admin')          -- add 'member' or 'viewer' as appropriate
  AND p.key = '<category>:<name>';

-- Down Migration
DELETE FROM app_permissions WHERE key = '<category>:<name>';
-- (app_role_permissions rows cascade-delete automatically)
```

### 2. Wire server middleware

In the relevant route file (e.g. `src/server/routes/admin.ts` or a feature-specific route):

```typescript
import { requirePermission, requireAnyPermission } from '../middleware/rbac';

// Single required permission (AND)
router.get('/my-feature', requirePermission('<category>:<name>'), handler);

// At least one of several (OR)
router.get('/my-feature', requireAnyPermission('<category>:<name>', 'admin:roles'), handler);
```

### 3. Wire client gating

```tsx
const { can } = useAppShell();

// Conditional render
{can('<category>:<name>') && <MyFeatureButton />}

// Route guard
if (!can('<category>:<name>')) return <Navigate to="/" />;
```

### 4. Update the permission catalog in the governance rule

Open `.cursor/rules/rbac-governance.mdc` and add the new key to the **Current Permission Catalog** table.

### 5. Verify

```bash
npx tsc -p tsconfig.server.json --noEmit
npx tsc -p tsconfig.json --noEmit
npm run migrate:local:up
```

---

## Workflow B: Removing a Permission

### 1. Confirm zero usages

Search across the whole codebase for the key string:

```
requirePermission('<key>')
requireAnyPermission('<key>')
can('<key>')
```

Proceed only if **all** results have already been removed from the code.

### 2. Remove client and server references (if not already done)

- Delete or update any `requirePermission` / `requireAnyPermission` call in route files.
- Delete or update any `can('<key>')` guard in component files.

### 3. Create the removal migration

```bash
npm run migrate:create -- remove-<key>-permission
```

```sql
-- Up Migration
DELETE FROM app_permissions WHERE key = '<key>';
-- app_role_permissions rows cascade-delete automatically

-- Down Migration
INSERT INTO app_permissions (id, key, description, category) VALUES
  (gen_random_uuid(), '<key>', '<original description>', '<category>');
-- Re-add role links if needed
```

### 4. Update the governance rule catalog

Remove the key row from the **Current Permission Catalog** table in `.cursor/rules/rbac-governance.mdc`.

---

## Workflow C: Modifying Role Assignments

To add or remove a permission from a role without touching the permission itself:

```bash
npm run migrate:create -- update-<role>-permissions
```

```sql
-- Up Migration: grant a permission to a role
INSERT INTO app_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM app_roles r, app_permissions p
WHERE r.name = '<role>' AND p.key = '<key>'
ON CONFLICT DO NOTHING;

-- Up Migration: revoke a permission from a role
DELETE FROM app_role_permissions
WHERE role_id = (SELECT id FROM app_roles WHERE name = '<role>')
  AND permission_id = (SELECT id FROM app_permissions WHERE key = '<key>');

-- Down Migration: reverse of the above
```

Then update the catalog table in `.cursor/rules/rbac-governance.mdc` to reflect the change.

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `migrations/1778778800000_rbac-tables.sql` | RBAC table DDL + initial permission/role seed data |
| `migrations/1778778900000_seed-bootstrap-admin.sql` | Bootstrap first admin user assignment |
| `src/server/services/rbacService.ts` | All DB queries: getUserPermissions, listRoles, assignRole, etc. |
| `src/server/middleware/rbac.ts` | `requirePermission`, `requireAnyPermission`, `attachPermissions` |
| `src/server/routes/admin.ts` | Admin API; entire router gated by `requirePermission('admin:roles')` |
| `src/server/routes/api.ts` | `GET /api/me/permissions` — returns current user's permissions and roles |
| `src/shared/types/rbac.ts` | Shared DTOs: AppRole, AppPermission, RoleWithPermissions, UserWithRoles, etc. |
| `src/client/hooks/useRbac.ts` | React Query hooks: useMyPermissions, useRoles, useUsers, mutations |
| `src/client/hooks/useAppShell.ts` | Exposes `permissions` and `can()` helper app-wide |
| `src/client/components/AdminRoles.tsx` | Admin UI for role/permission management (gated by `admin:roles`) |
| `src/client/components/AdminUsers.tsx` | Admin UI for user/role assignment (gated by `admin:roles`) |
| `.cursor/rules/rbac-governance.mdc` | Governance rule — keep the permission catalog here in sync |

---

## Middleware API Quick Reference

```typescript
// AND — user must have ALL listed keys
requirePermission('chat:create', 'chat:view_all')

// OR — user must have AT LEAST ONE listed key
requireAnyPermission('admin:roles', 'admin:users')

// Non-blocking — warms req._permissions for downstream use, never 403s
attachPermissions
```

Errors returned:
- `401 { error: 'Unauthorized' }` — no authenticated user on the request
- `403 { error: 'Forbidden', missing: string[] }` — missing required permission(s)
