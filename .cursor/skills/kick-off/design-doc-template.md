# Design Doc Template

Copy this file to `design-docs/<kebab-case-feature-name>.md` and fill in every section. Delete placeholder text and any sections that genuinely do not apply (e.g. "Database Schema" for a client-only change). Do not leave placeholder text in the committed file.

---

```markdown
---
name: <Feature Name>
overview: <1-2 sentence summary of what this feature does and why it is being built.>
todos:
  - id: phase-1a-<short-task-name>
    content: "Phase 1a: <Description of deliverable — be specific about files and functions>"
    status: pending
  - id: phase-1b-<short-task-name>
    content: "Phase 1b: <Description — tasks within a phase run in parallel>"
    status: pending
  - id: phase-2a-<short-task-name>
    content: "Phase 2a: <Description — depends on all Phase 1 tasks completing>"
    status: pending
isProject: false
---

# <Feature Name>

## Current State

Describe what exists today. Be concrete — name the files, services, or behaviors that are insufficient or missing. This section answers "why is this change needed now?"

## Architecture

```mermaid
flowchart TD
  subgraph db [PostgreSQL]
    tableA["table_a"]
    tableB["table_b"]
  end

  subgraph server [Express Server]
    serviceA["services/featureService.ts (new)"]
    routeA["routes/feature.ts (new)"]
  end

  subgraph client [React Client]
    hookA["hooks/useFeature.ts (new)"]
    compA["components/FeatureView.tsx (new)"]
  end

  routeA --> serviceA
  serviceA --> db
  hookA --> routeA
  compA --> hookA
```

## Database Schema

> Omit this section if no DB changes are required.

Create a single migration: `npm run migrate:create -- <migration-name>`

**`table_name`**
- `id` UUID PK DEFAULT gen_random_uuid()
- `user_id` TEXT NOT NULL — Azure AD OID
- `field_one` TEXT NOT NULL
- `field_two` JSONB — typed as `YourType` in schema.ts
- `created_at` TIMESTAMPTZ NOT NULL DEFAULT now()
- INDEX on `(user_id, created_at DESC)`

After creating the migration, update `src/server/db/schema.ts` with matching `pgTable` definitions and `relations()`.

## Server Changes

### Service: `src/server/services/featureService.ts` (new)

Follow patterns from `src/server/services/chatThreadRepository.ts` (Drizzle queries, typed returns).

- `functionOne(param: string): Promise<ReturnType>` — describe what it does
- `functionTwo(id: string, data: InputType): Promise<void>` — describe what it does

### Middleware (if applicable)

If the feature requires new middleware, describe it here. Otherwise omit.

### Routes: `src/server/routes/feature.ts` (new)

Mount at `/api/feature` behind `ensureAuthenticated` in `src/server/index.ts`.

| Method | Path | Auth | Body / Params | Returns |
|--------|------|------|---------------|---------|
| `GET` | `/` | session | — | `FeatureItem[]` |
| `POST` | `/` | session | `{ field: string }` | `201` + created item |
| `DELETE` | `/:id` | session | — | `204` |

## Client Changes

### Hook: `src/client/hooks/useFeature.ts` (new)

```typescript
export function useFeatureList() {
  return useQuery<FeatureItem[]>({
    queryKey: ['feature-list'],
    queryFn: () => apiFetch('/api/feature'),
    staleTime: 30_000,
  });
}
```

### Component: `src/client/components/FeatureView.tsx` (new)

- Lazy-loaded from `App.tsx` at route `/feature`
- Uses `react-hook-form` + `zod` for any forms
- CSS Module: `FeatureView.module.css` (use CSS variables from `App.css`, never hardcoded values)

### `App.tsx` changes

- Add `'feature'` to `CurrentView` union
- Add `/feature` path matching
- Lazy-import `FeatureView` wrapped in `Suspense` + `ErrorBoundary`

## Key Design Decisions

- **Decision 1**: State the trade-off and the choice made. Example: "Dual-write to both JSON and Postgres during transition — this lets us roll back to file-only if Postgres has issues without losing data."
- **Decision 2**: Another trade-off. Example: "Pagination via limit/offset rather than cursor — simpler for the current scale; cursor pagination can be added later without a breaking API change."
- **Decision 3**: Add as many as needed.

## Feature Flag

> Include this section when the kick-off interview chose feature-flag gating. Omit when the answer was **no**.

- **Flag key**: `my-feature-key` (kebab-case; create in Platform Admin > Feature Flags)
- **Server gating** (if applicable): `isFeatureEnabled('my-feature-key', { userId, project })` at route entry — return 404 when disabled
- **Client gating**: `useFeatureFlag('my-feature-key')` at the feature entry component (top-level split — not inside nested children)
- **Disabled path**: Describe what renders when the flag is off (legacy UI, `null`, or prior behavior)
- **Targeting**: Document initial rollout rules (project, user OID, or group)

## Phase Summary and Parallelization

```mermaid
flowchart LR
  P1a["Phase 1a: Migration + Schema"]
  P1b["Phase 1b: Shared Types"]
  P2a["Phase 2a: Service"]
  P2b["Phase 2b: Routes"]
  P3["Phase 3: Hook + Component"]

  P1a --> P2a
  P1b --> P2a
  P1b --> P2b
  P2a --> P2b
  P2b --> P3
```

**Multitask parallelism:**
- Phase 1 (1a + 1b) — both tasks have no dependencies; run in parallel
- Phase 2 (2a + 2b) — 2a (service) and 2b (routes) can start in parallel once Phase 1 is complete; 2b may need to import from 2a so coordinate on function signatures first
- Phase 3 — single task (depends on 2b)

## Files Changed / Created

| Action | Path |
|--------|------|
| Create | `migrations/<ts>_<migration-name>.sql` |
| Edit   | `src/server/db/schema.ts` |
| Create | `src/shared/types/feature.ts` |
| Create | `src/server/services/featureService.ts` |
| Create | `src/server/routes/feature.ts` |
| Edit   | `src/server/index.ts` |
| Create | `src/client/hooks/useFeature.ts` |
| Create | `src/client/components/FeatureView.tsx` |
| Create | `src/client/components/FeatureView.module.css` |
| Edit   | `src/client/App.tsx` |
```
