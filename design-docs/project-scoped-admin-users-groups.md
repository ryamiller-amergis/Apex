# Project-Scoped Admin Users and Groups

## Summary

The project-admin Users tab and the user/group pickers in Project Settings now show only records associated with the currently selected project. Project membership continues to use `user_project_assignments` as its source of truth.

## Behavior

- `GET /api/admin/users` remains a global user listing for existing callers.
- `GET /api/admin/users?project=<project>` returns users with a matching `user_project_assignments` row.
- User role assignments remain global; project scoping limits which users are visible, not which roles they hold.
- The Users tab passes the selected project through `useUsers(project)`.
- Project Settings passes the selected project through both `useUsers(project)` and `useGroupsWithMembers(project)`.

## Data Flow

1. The client adds the selected project as an encoded `project` query parameter.
2. The admin users route dispatches to `listUsersForProject` when that parameter is present.
3. The service loads user IDs assigned to the project and then loads those users with their role relations.
4. The service maps each result to the existing `UserWithRoles` response shape.

Global callers that omit the project parameter continue to use `listUsers()` unchanged.

## Verification

Coverage includes:

- Project membership filtering and role-name flattening in `listUsersForProject`.
- Empty-project behavior without an unnecessary user query.
- Route selection between global and project-scoped service methods.
- URL encoding in `useUsers(project)`.
- Propagation of `selectedProject` by the Users component.
