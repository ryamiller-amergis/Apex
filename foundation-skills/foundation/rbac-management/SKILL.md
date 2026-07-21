---
name: rbac-management
description: Add or remove RBAC permissions, roles, and authorization guards in a project with a permission-based access control system. Use when the user mentions RBAC, permissions, roles, or access control changes.
---

# RBAC Management — Foundation

Add or remove permissions, roles, and authorization guards in a project that uses role-based access control.

## Before making any changes

1. Load the project adapter for the specific RBAC system used by this project.
2. Read the project's RBAC governance documentation (specified in the adapter).
3. Identify the existing roles, permissions, and the permission catalog.
4. Understand the guard patterns already in use (middleware, hooks, UI guards).

## Adding a new permission

1. Define the permission key (kebab-case: `feature:action` format recommended).
2. Add it to the permission catalog (DB seed, enum, or configuration — per project adapter).
3. Assign it to the appropriate role(s).
4. Add server-side middleware/guard using the project's guard pattern.
5. Add client-side guard (conditional render, route guard, or hook) using the project's pattern.
6. Update RBAC documentation.

## Adding a new role

1. Define the role name and its intended scope (global or project-scoped).
2. Assign the appropriate permissions to the role.
3. Document the role in the RBAC documentation.

## Removing a permission or role

1. Confirm no code uses the permission/role before removing.
2. Remove or deprecate from the permission catalog.
3. Remove all server-side and client-side guard references.
4. Remove from role assignments.

## Guard patterns (generic)

The project adapter describes the specific guard API. Generic pattern:

```typescript
// Server: middleware-based guard
router.use(requirePermission('feature:read'));

// Client: conditional render
if (!can('feature:read')) return null;
// or
{can('feature:write') && <Button>Edit</Button>}
```

## Super-admin bypass

Many projects give super admins or global admins automatic bypass of permission checks. Always check the project adapter for the bypass rules before adding guards that might accidentally block admins.
