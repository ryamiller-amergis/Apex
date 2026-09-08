# Design — Effort Data Model & Shared Allow-List Foundations

> **PRD slug:** `per-module-agent-effort-defaults` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Per-Module Agent Effort Defaults | **Affected personas:** Project Admin, Developer
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (1 unresolved)

---

## Feature Summary

**Description:** Project Admins can already choose an AI model per Cursor-backed module in Project Settings, but there is no matching control for reasoning effort, and nobody can tell after the fact which effort actually produced a given artifact or cost row. This Feature is pure technical groundwork with no visible behavior change: it establishes the closed `low` / `medium` / `high` (+ Inherit) effort allow-list shared by client and server, and adds the nullable database columns — on Project Settings, on every artifact-audit table, and on the AI usage-event table — that the admin configuration UI (FEAT-002), the kickoff resolution service (FEAT-003), and the audit/cost display feature (FEAT-004) all build on. No effort value is set, resolved, or displayed by this Feature; every new column starts and stays `null` until later features populate it.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-001 | TBI | Add shared effort allow-list type and per-module effort columns to `project_skill_settings` | Must Have |
| TBI-002 | TBI | Add nullable effort snapshot column to artifact audit tables | Must Have |
| TBI-003 | TBI | Add nullable effort column to `ai_usage_events` | Must Have |

---

## Scope and Out-of-Scope

**In scope:**
- A closed TypeScript union (`low` / `medium` / `high`, with `null` meaning inherit) shared by client and server code, exported from a single canonical location.
- One nullable effort column per existing `*Model` stage on `project_skill_settings` (19 module-specific columns), plus one project-wide `defaultEffort` column.
- One nullable effort column on each of `interviews`, `adrs`, `prds`, `design_docs`, and `design_prototypes` — mirroring the existing `model` column already present on each.
- One nullable effort column on `ai_usage_events`, covering every Cursor-backed module including ones with no dedicated artifact table (Standup, Feature Request, Technical, Issue, Calendar Assistant, Load Test Generation, Design Module, Design Module Scoping).
- An optional `effort` field added to the shared `InterviewSkillOption`, `QuickSkillPill`, and `QuickMcpPill` types.
- Matching Drizzle schema (`src/server/db/schema.ts`) definitions for every new column.

**Out of scope:**
- Populating any effort value — this Feature only adds the columns and shared type; defaults remain `null` until FEAT-002 ships an admin UI to set them.
- Effort support for Bedrock-only stages (PRD review, Design Prototype/UI Lab Bedrock generation, Design Plan) — those keep their existing max-tokens/timeout/temperature knobs and get no effort column.
- Any new skill files, new services, or new SSE event/streaming types.
- New RBAC permission keys.
- Backfilling effort onto artifacts or usage events created before this Feature ships.
- Reading or writing the new columns through any service, route, or UI — that begins in FEAT-002 (admin settings), FEAT-003 (kickoff resolution), and FEAT-004 (audit/cost display).

---

## Target Surface

**Primary surface:** Shared types only + database migration. No React component, no new or modified Express route, and no user-visible behavior changes anywhere in the product. The Drizzle schema and shared type files are compiled into both the client and server bundles (so later UI/API work can import them), but this Feature ships zero client runtime code and zero new/modified endpoints.

**Experience notes:** Not applicable — there is nothing for any user, including a Project Admin, to see or do differently after this Feature ships. The epic's overall Target Surface (full-stack, one new effort selector per module in Admin → Project Settings) is delivered entirely by FEAT-002 through FEAT-004.

---

## Access Control

No new endpoint, UI action, or data-read path is introduced by this Feature — the new columns are inert until a later feature opens a path to them. The only "action" that exists at this Feature's layer is applying the schema change itself:

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Merge and apply the migrations adding the new effort columns/type | Developer, via normal repository merge + `npm run migrate:up` deployment step (existing CI/CD gate, not a new one) | Not applicable — DDL change, not a per-project or per-user runtime action |

**Feature flag:** `None` — rollout: `Not applicable` (GA from launch per the epic; a flag is unnecessary because every new column defaults to `null`/inherit, which is a no-op until a Project Admin explicitly opts in via FEAT-002).
**Behavior when flag is off:** Not applicable — no flag exists for this Feature or the epic.

---

## Acceptance Criteria

This Feature contains **no PBIs** — all three work items are TBIs delivering shared-type and schema groundwork with no direct user-facing behavior. The acceptance criteria below are expressed as technical Given/When/Then per TBI, derived from each TBI's Definition of Done and Non-Functional Requirements, covering the same four scenario categories (happy path, error/failure, edge case, negative) the skill requires for PBIs.

### TBI-001 — Add shared effort allow-list type and per-module effort columns to `project_skill_settings`

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | The migration and matching `schema.ts` changes are applied | A developer runs `npm run migrate:local:up` then `npx tsc -p tsconfig.server.json --noEmit` | All 20 nullable columns (19 per-module + `defaultEffort`) exist on `project_skill_settings`, and the server build compiles with zero type errors against the new `EffortLevel`-typed columns |
| (b) Error/failure | A developer attempts to add one of the new columns as `NOT NULL` with no default | The migration is reviewed against this Feature's NFRs | The migration is rejected in review — every new column must be nullable with no backfill, since existing rows must resolve to inherit/omit until an admin sets a value |
| (c) Edge case/boundary | `EffortLevel` is imported into both a server file (`schema.ts`) and a client file (a future Project Settings component) | The client bundle (`tsconfig.client.json`) is built | The build succeeds with no server-only dependency pulled into the client bundle, because `effort.ts` contains only a literal type and a small array/guard function with zero imports |
| (d) Negative scenario | A developer writes `effort: 'urgent'` against a variable typed `EffortLevel` | The code is compiled | `tsc` raises a compile-time type error; this is a compile-time-only guard — it does not and cannot block a raw string written directly to the database outside TypeScript, which is exactly what BR-005 anticipates |

### TBI-002 — Add nullable effort snapshot column to artifact audit tables

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | The migration is applied to `interviews`, `adrs`, `prds`, `design_docs`, and `design_prototypes` | An existing row in any of these tables is read | The row returns `effort: null` with no error; the column shape exactly matches the existing nullable `model` column on the same table |
| (b) Error/failure | A developer attempts to add the column as `NOT NULL` | The migration is reviewed | Rejected — nullable with no backfill is required, matching the existing `model`-column precedent on these five tables |
| (c) Edge case/boundary | A `design_prototypes` row is inserted for a project whose `prototypeEngine` is `bedrock` (not `agent`) | The insert omits `effort` | The insert succeeds with `effort: null` — the column carries no DB-level constraint tying it to the agent-engine path, because `design_prototypes` has no `prototypeEngine` column of its own to constrain against; that scoping is an application-level rule enforced later, in FEAT-004 |
| (d) Negative scenario | An `interview` row created before this Feature shipped is read after the migration | The interview header (unchanged in this Feature) renders | Rendering is unaffected — the pre-existing row simply has `effort: null`, and no backfill is attempted or expected |

### TBI-003 — Add nullable effort column to `ai_usage_events`

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | The migration is applied to `ai_usage_events` | A usage event for a module with no dedicated artifact table (e.g. Standup) is later written by FEAT-004 | The row can carry a non-null `effort` value even though Standup has no artifact table to snapshot onto — the universal column on `ai_usage_events` is the only audit surface for those stages |
| (b) Error/failure | A developer proposes adding an index on the new `effort` column in the same migration | The migration is reviewed against TBI-003's NFRs | Rejected in review — "no new index" is explicit, since effort is not filtered in `WHERE` clauses at this stage |
| (c) Edge case/boundary | An existing `ai_usage_events` row (written before this migration) is read after the migration | A cost-analytics query selects `effort` | The column returns `null` for every pre-existing row, with no query error and no special-casing required |
| (d) Negative scenario | A row is inserted with `effort` omitted entirely (the common case until FEAT-003/FEAT-004 ship) | The insert executes | It succeeds — the column accepts `NULL` for any event where effort was never resolved, including all Bedrock-only stages, which never populate this column at all |

---

## UI/UX

Not applicable. This Feature introduces no screens, components, routes, or `data-testid` attributes. The one new UI element the epic eventually needs — an effort dropdown next to each module's model dropdown in Admin → Project Settings — is delivered by FEAT-002 (TBI-004), which extends `AdminProjectSettings.tsx` and the project-settings API to actually read and write the columns this Feature only creates.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
