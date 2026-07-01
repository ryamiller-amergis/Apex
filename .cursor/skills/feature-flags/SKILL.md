---
name: feature-flags
description: Wrap existing features with feature flags (top-level split pattern) and clean up retired flags. Use when the user mentions feature flags, gating, rollout, flag cleanup, or retiring a flag.
---

# Feature Flags Skill

This skill covers two workflows: wrapping an existing feature behind a feature flag ("top-level split") and automated cleanup of retired flags.

## Evaluation Contract

Flags are evaluated via `GET /api/feature-flags/evaluate?project=<current-project>`. The response is `{ flags: Record<string, boolean> }`. A flag is ON only when:
1. `enabled === true` (kill switch is off)
2. At least one targeting rule matches the current context (user OID, project name, or group membership within the project)
3. `lifecycle !== 'archived'`

Server-side: `isFeatureEnabled(key, ctx)` from `src/server/services/featureFlagService.ts`.
Client-side: `useFeatureFlag(key)` from `src/client/hooks/useFeatureFlags.ts`.

## Workflow 1: Wrap a Feature (Top-Level Split)

Use this when gating an existing or new feature behind a flag for targeted rollout.

### Steps

1. **Create the flag** — In Platform Admin > Feature Flags tab, create a flag with a kebab-case key (e.g. `new-dashboard`, `ai-suggestions`). Keys must be unique and descriptive.

2. **Server-side gating** (if the feature has server behavior to gate):
   ```typescript
   import { isFeatureEnabled } from '../services/featureFlagService';
   import { getUserId } from '../utils/requestUser';

   router.get('/my-feature-endpoint', async (req, res) => {
     const userId = getUserId(req);
     const project = req.query.project as string;
     const enabled = await isFeatureEnabled('my-feature-key', { userId, project });
     if (!enabled) {
       res.status(404).json({ error: 'Not found' });
       return;
     }
     // ... feature logic
   });
   ```

3. **Client-side gating** (top-level split — gate at the feature's entry point, NOT deep inside):
   ```tsx
   import { useFeatureFlag } from '../hooks/useFeatureFlags';

   export const MyFeatureView: React.FC<Props> = (props) => {
     const isEnabled = useFeatureFlag('my-feature-key');

     if (!isEnabled) return null; // or render the legacy path

     return <NewFeatureImplementation {...props} />;
   };
   ```

4. **Add targeting rules** — In the admin tab, add rules targeting specific projects, users, or groups to enable the flag for them.

### Key Principles
- Gate at the TOP level (route guard or component entry point) — do not scatter flag checks throughout nested components
- Keep both branches (enabled/disabled) functional — the disabled path should be the previous behavior or null
- One flag per feature — do not reuse flags across unrelated features
- Name flags after the feature, not the ticket (e.g. `new-dashboard` not `JIRA-1234`)

## Workflow 2: Automated Cleanup (Retire a Flag)

Use this when a flag has been fully rolled out (enabled for everyone) or is no longer needed.

### Prerequisites
- The flag's `lifecycle` should be set to `stale` or `cleanup_ready` should be `true` in the admin UI
- Confirm with the team that the feature is stable and the flag can be removed

### Steps

1. **Find all references** to the flag key:
   ```
   Search for: 'my-feature-key' across the codebase
   Patterns to find:
   - useFeatureFlag('my-feature-key')
   - isFeatureEnabled('my-feature-key', ...)
   - Any string literal matching the key
   ```

2. **Inline the winning branch**:
   - If the flag was ON for everyone: keep the enabled/true branch, delete the disabled/false branch and the flag check
   - If the flag is being retired without full rollout: keep the disabled/false branch (legacy path), delete the enabled branch and the flag check
   - Remove the import of `useFeatureFlag` or `isFeatureEnabled` if no other flags remain in that file

3. **Remove the flag from the database**:
   - Option A (preferred): Delete via Platform Admin > Feature Flags tab (audit log preserved automatically)
   - Option B: Create a migration if the flag was seeded via migration

4. **Verify**:
   ```bash
   npx tsc -p tsconfig.server.json --noEmit
   npx tsc -p tsconfig.client.json --noEmit
   npm test
   ```

5. **Update lifecycle**: If not deleting, set lifecycle to `archived` in the admin UI.

### Cleanup Checklist
- [ ] All `useFeatureFlag('key')` calls removed, winning branch inlined
- [ ] All `isFeatureEnabled('key', ...)` calls removed, winning branch inlined
- [ ] No remaining string references to the flag key in source code
- [ ] Type-check passes (both configs)
- [ ] Tests pass
- [ ] Flag deleted or archived in admin

## File References

| Purpose | Path |
|---------|------|
| Service (server eval) | `src/server/services/featureFlagService.ts` |
| Evaluate route | `src/server/routes/featureFlags.ts` |
| Admin management routes | `src/server/routes/platformAdmin.ts` |
| Client eval hook | `src/client/hooks/useFeatureFlags.ts` |
| Admin UI | `src/client/components/PlatformAdmin.tsx` |
| DB schema | `src/server/db/schema.ts` |
| Shared types | `src/shared/types/featureFlags.ts` |
