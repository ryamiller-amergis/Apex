# Assumptions — Effort Snapshot on Audit & Cost History

## Feature header

| Field | Value |
|---|---|
| Feature title | Effort Snapshot on Audit & Cost History |
| Feature ID | FEAT-004 (epic: Per-Module Agent Effort Defaults) |
| PRD slug | `per-module-agent-effort-defaults` |
| Work items | PBI-003 (See the effort level that ran on an artifact and in cost history), TBI-006 (Persist resolved effort snapshot on artifact create paths and usage events; render next to model in existing views) |
| Priority | Must Have |
| Feature flag | None — GA from launch, per PRD `## Feature Flag` |
| Feature-level dependencies | FEAT-001 (Effort Data Model & Shared Allow-List Foundations), FEAT-002 (Admin Per-Module Effort Defaults), FEAT-003 (Server-Authoritative Effort Resolution at Kickoff) |
| Linked documents | [`design-doc-design.md`](./design-doc-design.md), [`design-doc-tech-spec.md`](./design-doc-tech-spec.md) |

This feature is scoped to **FEAT-004 only**. FEAT-001–003 (schema/allow-list, admin settings UI, kickoff resolution) are treated as delivered dependencies; this document does not re-specify them, only what FEAT-004 consumes from each.

---

## Unresolved items

### ⚠ UNRESOLVED-1 — No agent-engine dispatch branch exists yet for Design Prototype generation

- **Question:** TBI-006 asks to extend the "agent-engine Design Prototype create path" to snapshot resolved effort. `project_skill_settings.prototypeEngine` (`'bedrock' | 'agent'`, `src/shared/types/projectSettings.ts:49`) is a stored, admin-editable config value, but at the pinned SHA `designPrototypeService.generatePrototypesForPrd()` (`src/server/services/designPrototypeService.ts:339`) always resolves a Bedrock model and never branches on `prototypeEngine === 'agent'` to route through `chatAgentService`/the Cursor SDK. There is no call site that would ever produce a Cursor-resolved effort value for a prototype today.
- **Impact:** The "agent-engine Design Prototype" half of TBI-006 has no code to extend. Shipping only the Bedrock-analogous plumbing would silently under-deliver against the DoD line; blocking FEAT-004 entirely on a prototype-generation rewrite would delay Interview/PRD/ADR/Design Doc, which are fully buildable today.
- **Decision needed:** Either (a) treat the agent-engine dispatch branch as a prerequisite outside FEAT-004's stated scope and build it first, or (b) ship the schema-to-UI plumbing for `design_prototypes.effort` / `DesignPrototypeSummary.effort` now (so it activates automatically once the dispatch branch lands) and explicitly exclude an agent-engine snapshot call from this feature's implementation plan.
- **Default applied (non-interactive run):** (b). `design_prototypes.effort` (already added by FEAT-001) is read through to `DesignPrototypeSummary.effort` and rendered next to `proto.model` wherever the client already renders it, so the read path is complete and forward-compatible. No write-side snapshot call is added to `designPrototypeService.ts` because there is no agent-engine call site to attach it to. This is called out explicitly in the tech spec's Implementation Plan as a follow-up once the dispatch branch exists, not a silent gap.

### ⚠ UNRESOLVED-2 — Mirroring the `model` precedent for client-supplied `effort` would reopen the exact gap BR-002 exists to close

- **Question:** The existing model-audit precedent (`design-docs/ai-model-audit-tracking.md`) has the **client** supply `model` on `POST /api/interviews` and PRD creation (`req.body.model`, trusted as-is — see `src/server/routes/interviews.ts:190,238`). PBI-002/BR-002 (FEAT-003) require the server to resolve `effort` itself and "ignore any effort value a client attempts to supply on kickoff, on a later turn, or on an artifact-create request" — for every module, with no carve-out for Interview or PRD.
- **Impact:** If FEAT-004 naively copies the `model` pattern for `effort` on the Interview/PRD create routes (accept `req.body.effort`, pass it straight to `createInterview`/`createPrd`), a malicious or buggy client could set `effort` on artifact rows even though FEAT-003 correctly refuses to let it influence the actual Cursor SDK call — the artifact row would then lie about what effort produced it.
- **Decision needed:** Confirm the artifact-create routes must source `effort` from the durably persisted `chatThreads.kickoff.effort` (via `getThread(chatThreadId)`, `src/server/services/chatAgentService.ts:3027`) rather than `req.body`, even on the two routes where `model` still trusts the client.
- **Default applied (non-interactive run):** Yes. `effort` is never destructured from `req.body` on any artifact-create route (`interviews.ts`, `adr.ts`, PRD/design-doc creation paths). Interview/ADR/PRD read the already-resolved value off the persisted thread kickoff; Design Doc (which already resolves `model` server-side before `createThread()`, `interviews.ts:605`) resolves `effort` the same way, alongside `model`, before the thread is created. This is intentionally stricter than the `model` precedent it sits next to — documented here so a future reviewer doesn't "fix" it to match `model` and reopen BR-002.

---

## Assumptions accepted

1. **`EffortLevel` shared type is owned by FEAT-001, not redefined here.** Assumed shape: `export type EffortLevel = 'low' | 'medium' | 'high';` (nullable via `EffortLevel | null` on DB-facing code, `EffortLevel | undefined` on shared summary types — mirroring how `model?: string` is typed today), colocated in `src/shared/types/projectSettings.ts` next to `PrototypeEngine`/`SkillProvider`. FEAT-004 imports it wherever `effort` is typed.

2. **No migration in this feature.** `effort TEXT NULL` already exists on `interviews`, `adrs`, `prds`, `design_docs`, `design_prototypes` (FEAT-001 / TBI-002) and on `ai_usage_events` (FEAT-001 / TBI-003), with matching Drizzle columns in `src/server/db/schema.ts`. FEAT-004 only reads/writes these columns and renders them — it adds zero DDL.

3. **FEAT-003 stamps `ChatThreadKickoff.effort` at the exact point `model` is resolved today.** The precedent is `resolveModelId()` / `resolvedModel` in `src/server/services/chatAgentService.ts:3075,4595` and the `state.thread.kickoff.model = resolvedModel` assignment immediately after — persisted durably via the existing `pgUpsertThread(state.thread)` call (`chatAgentService.ts:4624`). FEAT-004 assumes an analogous `state.thread.kickoff.effort` is set at the same point and persists the same way; it never re-implements resolution, it only reads the already-resolved field.

4. **Effort is fixed for the life of a thread (BR-004), exactly like `model` is fixed unless a `SendMessageRequest.model` override changes it.** `SendMessageRequest` (`src/shared/types/chat.ts`) has no `effort` override field, and BR-002 explicitly forbids a client-supplied effort influencing any turn — so every usage-event write for a thread reads the same fixed `kickoff.effort` captured at kickoff, never a fresh admin-settings lookup per turn.

5. **Display casing.** Stored values are lowercase (`'low' | 'medium' | 'high'`); the UI renders Title Case (`Low` / `Medium` / `High`) to match PBI-003 AC1 ("the card shows Medium next to the existing model selection" — capitalized). A small `EFFORT_LABELS` lookup (mirroring the existing `FEATURE_LABELS` map in `AiCostAnalytics.tsx`) is used instead of a blind `.charAt(0).toUpperCase()` transform, so a corrupted/unrecognized stored string (BR-005) still renders literally instead of crashing a `.toUpperCase()` call on an unexpected type.

6. **`ArtifactUsageStrip.tsx`'s expandable per-run breakdown is in scope as an existing "cost view."** It already renders `run.modelId` per run and already null-hides gracefully when data is absent (`src/client/components/ArtifactUsageStrip.tsx`), so it counts as one of the "existing places that already display the snapshotted model" the PRD says must show effort next to it. The epic-level out-of-scope line ("no new AI Cost Analytics view or dashboard filter by effort") is read narrowly: it rules out new charts/filters/dashboards, not extending an existing per-run detail line that already shows model.

7. **`EntityUsageRollup.models: string[]` (the rollup-level distinct-model list) is left unchanged.** Nothing in the client currently renders that array as a list (it exists for the `incomplete`/cost-pending calculation), so no companion `efforts: string[]` is added — only the per-run `EntityUsageRun.effort` field, which the UI does render.

8. **Modules with no dedicated artifact table** (Standup, Feature Request, Technical, Issue, Calendar Assistant, Load Test Generation, Design Module, Design Module Scoping) surface effort only through the AI Cost Analytics Interaction Log row for their `ai_usage_events` entries — there is no artifact header to add it to, per the PRD's own assumption and TBI-003's scope.

9. **`recordCursorChatUsage()`'s existing `kickoff` parameter object gains one optional field** (`effort?: EffortLevel`) rather than a new top-level parameter, keeping every existing call site's shape (`{ mode, assistantType, skillPath, standupSessionId, pillLabel, project }`) additive and non-breaking.

10. **Bedrock-only stages stay untouched.** PRD review, Design Prototype/UI Lab Bedrock generation, and Design Plan (`bedrockService.ts`, `uiLabBedrockService.ts`, `aiCostInsightsService.ts`, `aiCostDailyBriefService.ts`) keep calling `recordAiUsage()` without an `effort` argument, which resolves to `null` — consistent with the epic's explicit out-of-scope line for Bedrock-only stages.

11. **No new permission key.** `analytics:ai-cost:view` already gates the entire `/api/ai-cost` router (`router.use(requirePermission('analytics:ai-cost:view'))`, `src/server/routes/aiCost.ts:13`) and therefore already gates the new `effort` field on every response from that router. No additional check is introduced.

12. **Null effort renders as literally nothing** — no `"—"`, no `"Inherit"` placeholder — on every surface this feature touches, matching the existing `{doc.model && (...)}` guard pattern used for `model` today and TBI-006's explicit DoD line ("Null effort renders as absent, not as an error or placeholder string").

13. **Historical rows are never backfilled** (epic-level out-of-scope, restated here): any interview/PRD/ADR/design doc/usage-event row created before this feature ships has `effort = NULL` forever, and the UI must treat that identically to a deliberate "Inherit" resolution — both render nothing.
