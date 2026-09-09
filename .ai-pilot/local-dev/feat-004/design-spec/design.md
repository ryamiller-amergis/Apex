# Effort Snapshot on Audit & Cost History — Design Doc

## 1. Feature Summary

| Field | Value |
|---|---|
| Title | Effort Snapshot on Audit & Cost History |
| Parent Epic | Per-Module Agent Effort Defaults |
| PRD slug | `per-module-agent-effort-defaults` |
| Priority | Must Have |
| Feature flag | None (GA from launch) |
| Affected personas | BA, Product-Owner, Manager, Developer, Authenticated User |

**Description:** Anyone who can already open an Interview, PRD, ADR, or Design Doc sees the reasoning effort that actually ran next to the model already shown on that artifact's header. Users with `analytics:ai-cost:view` see effort next to model on AI Cost Analytics rows and per-artifact usage detail — the same way model is already shown, using the value snapshotted once at kickoff (FEAT-003) and never re-resolved for the life of that thread (BR-004).

### Work item index

| ID | Type | Title | Priority |
|---|---|---|---|
| PBI-003 | PBI | See the effort level that ran on an artifact and in cost history | Must Have |
| TBI-006 | TBI | Persist resolved effort snapshot on artifact create paths and usage events; render next to model in existing views | Must Have |

---

## 2. Scope and Out-of-Scope

**In scope**

- Snapshot the already-resolved effort value onto the artifact row at creation time for Interview, PRD, ADR, and Design Doc (Design Prototype is schema/type-ready but has no agent-engine call site to snapshot from yet — see `design-doc-assumptions.md` UNRESOLVED-1).
- Include the resolved effort on every `ai_usage_events` row the usage/cost recording service writes, for every Cursor-backed module — including the eight modules that have no dedicated artifact table (Standup, Feature Request, Technical, Issue, Calendar Assistant, Load Test Generation, Design Module, Design Module Scoping).
- Render effort next to the already-displayed model on: Interview, ADR, PRD, and Design Doc headers; the per-run usage breakdown (`ArtifactUsageStrip`); and the AI Cost Analytics Interaction Log.
- Render nothing (not an error, not a placeholder) when effort is `null` — the pre-launch default for every existing row and any module a Project Admin hasn't opted into yet.

**Out of scope**

- Filtering or grouping cost history by effort — display only, no new query capability (PBI-003).
- A new AI Cost Analytics view, chart, or dashboard filter keyed on effort — effort is shown inline on existing rows/headers only (FEAT-004, epic).
- Backfilling effort onto artifacts or usage events created before this feature ships (epic).
- Effort for Bedrock-only stages — PRD review, Design Prototype/UI Lab Bedrock generation, Design Plan — which keep their existing max-tokens/timeout/temperature knobs (epic).
- Anything about *setting* a default effort (FEAT-002) or *resolving* it at kickoff (FEAT-003) — this feature only consumes the value those features already produced.

---

## 2b. Target Surface

- **Primary surface:** Full-stack (both client and server) — server persists the snapshot, client renders it.
- **Experience notes:** No new pages, routes, or navigation entries. Artifact headers and AI Cost Analytics gain a small "Effort" label next to the existing "Model" label, exactly where a Project Admin would look for it having just configured it in FEAT-002.

---

## 2c. Access Control

| Action | Required group(s) / role(s) | Data scope |
|---|---|---|
| View the snapshotted effort on an artifact | Whoever already opens that Interview, PRD, ADR, or Design Doc | Project-scoped |
| View effort on cost history | Users with `analytics:ai-cost:view` | Project-scoped |

**Feature flag behavior when disabled:** Not applicable — there is no flag. A `null` effort (the default until a Project Admin sets one in FEAT-002) renders exactly as today's model-only header, so there is no visible change until an admin opts a module in.

---

## 3. Acceptance Criteria

Consolidated from PBI-003 (`See the effort level that ran on an artifact and in cost history`):

| # | Given | When | Then |
|---|---|---|---|
| AC1 (happy path) | An interview was created after a Project Admin set the Interview module's effort to Medium | I open that interview's header | The header shows **Medium** next to the snapshotted model |
| AC2 (edge — legacy data) | An interview was created before this feature shipped and has no stored effort value | I open that interview's header | No effort label is shown and no error appears — the header renders exactly as it did before |
| AC3 (edge — snapshot stability, BR-004) | An interview thread is in progress with effort snapshotted as Medium | A Project Admin changes the Interview module's default to High and I send another message in that same thread | The thread's artifact header **and** any new usage-event rows for that thread still show Medium, not High |
| AC4 (negative — permission) | I am a user without `analytics:ai-cost:view` | I call the AI cost/usage API | I am denied access and cannot see any effort values on cost rows |

Cross-references: BR-004 ("Effort is resolved and snapshotted once at kickoff; later turns in the same thread reuse that snapshot even if a Project Admin changes the module's default afterward") governs AC3. `analytics:ai-cost:view` (existing permission, unchanged) governs AC4.

---

## 4. UI/UX

**Components touched (all existing — no new components):**

| Component | Change |
|---|---|
| `InterviewChatView.tsx` | Existing-interview header meta row gains `{interview.effort && <span>Effort: {effortLabel(interview.effort)}</span>}` next to the existing `Model: {interview.model}` |
| `AdrChatView.tsx` | Header meta line gains `Effort: {effortLabel(adr.effort)}` next to the existing `Model: {adr.model ?? 'Default'}` |
| `PrdReviewView.tsx` | `metaRow` gains an effort item next to the existing model item |
| `DesignDocReviewView.tsx` | `metaRow` gains an effort item next to the existing model item |
| `ArtifactUsageStrip.tsx` | Expanded per-run breakdown line gains effort next to the existing `run.modelId` |
| `AiCostAnalytics.tsx` (`EventsTable`) | Interaction Log table gains an **Effort** column next to the existing **Model** column |

**Routes:** none added or changed — every surface above already exists at its current route (`/backlog`, `/adr`, `/ai-cost`).

**States:**
- *Present:* effort label renders in Title Case (`Low` / `Medium` / `High`) next to model.
- *Absent (`null`):* nothing renders — no placeholder text, no dash, no "Inherit" label. This is the default state for every artifact until a Project Admin opts a module into a non-Inherit default (FEAT-002) and a new run happens under it.
- *Unrecognized/corrupted stored value:* renders the raw stored string as-is rather than throwing (defensive display only — rejection of bad values at the source is FEAT-002/FEAT-003's job per BR-003/BR-005).

**Validation:** none — this is a read-only display feature. All write-side validation (allow-list enforcement) belongs to FEAT-002's admin settings endpoint.

**Accessibility:** Reuses the existing plain-text meta-label/meta-value pattern already used for model (`<span>Model: ...</span>` style nodes) — no new ARIA roles or landmarks needed. This matches the PRD's own NFR: "The effort label reuses the existing meta-label/meta-value pattern already used for model, inheriting its accessibility treatment."

**`data-testid`:** None of the existing model spans in `InterviewChatView.tsx`, `AdrChatView.tsx`, `PrdReviewView.tsx`, or `DesignDocReviewView.tsx` carry a dedicated `data-testid` today — the effort span follows the same convention (no new testid) unless a specific E2E/walkthrough assertion needs to target it, in which case add `data-testid="{entity}-effort-label"` to match the existing `data-testid` conventions used elsewhere in these files (e.g. `ai-cost-events-*` in `AiCostAnalytics.tsx`).

**Not applicable:** No backend-only sections apply here — this feature is full-stack by nature (server snapshot + client render), but there is no standalone backend-only surface to call out separately.

---

## 5. Link to technical specification

See [`design-doc-tech-spec.md`](./design-doc-tech-spec.md) for the engineering design: exact files/functions touched, the security rationale for never trusting client-supplied effort, data contracts, test matrix, and implementation sequencing. Shared assumptions and the two open decisions this doc relies on are recorded in [`design-doc-assumptions.md`](./design-doc-assumptions.md).
