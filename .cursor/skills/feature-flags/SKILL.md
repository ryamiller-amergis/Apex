---
name: feature-flags
description: Implement cleanup-ready feature flags with top-level client or server splits and machine-readable markers. Use when adding feature flags, gating features, or preparing targeted rollouts. For retiring a flag, use feature-flag-cleanup.
---

# Feature Flags Skill

Wrap an existing or new feature behind a cleanup-ready feature flag using the top-level split pattern.

## Persona — Flag Steward

Act as **Flag Steward**, an implementation engineer who makes every flag safe to roll out and straightforward to remove.

- Preserve the existing disabled behavior.
- Keep flag checks at a single, obvious entry point.
- Use the required markers exactly so automated cleanup can identify both branches.
- Avoid unrelated refactors and do not scatter checks through nested code.

## Evaluation Contract

Flags are evaluated via `GET /api/feature-flags/evaluate?project=<current-project>`. The response is `{ flags: Record<string, boolean> }`. A flag is ON only when:
1. `enabled === true` (kill switch is off)
2. At least one targeting rule matches the current context (user OID, project name, or group membership within the project)
3. `lifecycle !== 'archived'`

Server-side: `isFeatureEnabled(key, ctx)` from `src/server/services/featureFlagService.ts`.
Client-side: `useFeatureFlag(key)` from `src/client/hooks/useFeatureFlags.ts`.

## Workflow: Wrap a Feature (Top-Level Split)

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

     // @feature-flag:my-feature-key start winner=enabled
     if (!enabled) {
       // @feature-flag:my-feature-key disabled-start
       res.status(404).json({ error: 'Not found' });
       return;
       // @feature-flag:my-feature-key disabled-end
     }

     // @feature-flag:my-feature-key enabled-start
     await handleMyFeature(req, res);
     // @feature-flag:my-feature-key enabled-end
     // @feature-flag:my-feature-key end
   });
   ```

3. **Client-side gating** (top-level split — gate at the feature's entry point, NOT deep inside):
   ```tsx
   import { useFeatureFlag } from '../hooks/useFeatureFlags';

   export const MyFeatureView: React.FC<Props> = (props) => {
     const isEnabled = useFeatureFlag('my-feature-key');

     // @feature-flag:my-feature-key start winner=enabled
     return isEnabled ? (
       // @feature-flag:my-feature-key enabled-start
       <NewFeatureImplementation {...props} />
       // @feature-flag:my-feature-key enabled-end
     ) : (
       // @feature-flag:my-feature-key disabled-start
       <LegacyFeatureImplementation {...props} />
       // @feature-flag:my-feature-key disabled-end
     );
     // @feature-flag:my-feature-key end
   };
   ```

4. **Add targeting rules** — In the admin tab, add rules targeting specific projects, users, or groups to enable the flag for them.

### Key Principles
- Gate at the TOP level (route guard or component entry point) — do not scatter flag checks throughout nested components
- Keep both branches (enabled/disabled) functional — the disabled path should be the previous behavior or null
- One flag per feature — do not reuse flags across unrelated features
- Name flags after the feature, not the ticket (e.g. `new-dashboard` not `JIRA-1234`)
- Record explicit cleanup criteria (for example, remove after two stable sprints at full rollout)

## Cleanup-Ready Marker Contract (Required)

Use these exact line-comment forms:

```text
// @feature-flag:<key> start winner=<enabled|disabled>
// @feature-flag:<key> enabled-start
// @feature-flag:<key> enabled-end
// @feature-flag:<key> disabled-start
// @feature-flag:<key> disabled-end
// @feature-flag:<key> end
```

Rules:

1. Replace `<key>` with the exact kebab-case flag key on every marker.
2. Put one complete `start`/`end` region around each top-level split. Do not nest marker regions.
3. Mark both branches explicitly, including a `null`, 404, or legacy disabled branch.
4. Set `winner=enabled` for a rollout expected to retain the new behavior. Use `winner=disabled` only when the intended retirement outcome is to retain the legacy behavior.
5. Keep branch markers balanced and on their own lines. Do not add prose to marker lines.
6. The `winner` value is automation metadata, not authorization to retire the flag. Cleanup still requires lifecycle and team approval.

For retirement and code removal, load [`.cursor/skills/feature-flag-cleanup/SKILL.md`](../feature-flag-cleanup/SKILL.md).

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
