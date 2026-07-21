---
name: rbac-management
description: APEX adapter for rbac-management. Binds to APEX's rbacService and permission catalog.
---

# rbac-management — APEX Adapter

<!-- Managed loader: loads .apex/foundation/rbac-management/SKILL.md -->

- Project: {{slot:projectName}}
- Service: `src/server/services/rbacService.ts`
- Permission catalog: `.cursor/rules/rbac-governance.mdc`
- Middleware: `src/server/middleware/rbac.ts` (`requirePermission`, `requireSuperAdmin`)
- Client gate: `src/client/hooks/usePermission.ts` (or equivalent)
- Admin UI: `src/client/components/AdminRoles.tsx`, `AdminUsers.tsx`
