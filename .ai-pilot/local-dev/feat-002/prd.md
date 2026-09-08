<!-- apex-grounded-sha:bde02baf46bf988fde9f4a48edeb118be52e8cf4 -->

> Based on the **Apex** project, **main** branch, as of Sep 8, 2026.
---
title: Per-Module Agent Effort Defaults
slug: per-module-agent-effort-defaults
created: 2026-09-08
triage-status: needs-triage
glossary-terms-used:
  - Skill
  - Skill Pill
  - Project Admin
  - Interview
  - PRD
  - Design Doc
  - Design Prototype
  - RBAC
---

# Per-Module Agent Effort Defaults

## Problem Statement

Admin → Project Settings lets a Project Admin choose an AI model for every Cursor-backed agent module — Interview, PRD, ADR, Design Doc, and the rest — but there is no matching control for reasoning effort. Every module always runs at whatever effort the Cursor SDK defaults to, so a Project Admin cannot make a routine module run cheaper and faster, or make a high-stakes module think harder. Once a module runs, nobody can tell which effort actually produced a given artifact or cost row, because artifact audit columns and AI usage events only ever recorded the model.

## Solution

Every Cursor-backed module gets a sibling effort control next to its existing model override in Project Settings, with an explicit Inherit option. When that module starts a run, the server resolves the configured effort the same way it already resolves the model, passes it to the Cursor SDK, and snapshots the resolved value on the artifact and on the usage/cost record — the same way model is already snapshotted. There is no runtime effort picker: whatever a Project Admin configured is what runs, and it stays fixed for an in-flight conversation even if the default changes later.

## Implementation Decisions

- **Shared effort allow-list.** A closed union of `low` / `medium` / `high` (plus null, meaning inherit) used consistently by client and server — the same pattern already used for the model-ID union. The admin write path rejects any other value; a run-time resolver that encounters an unrecognized or corrupted stored value treats it as unset rather than failing the run.

- **Project settings configuration (deep module).** The configuration store that already holds one model override per module is extended to hold a sibling effort override per module, plus one project-wide default effort. Resolution order — module override → project default → omit (SDK default) — is centralized behind the same configuration-resolution interface every caller already uses for model, so effort and model always travel the same path.

- **Agent kickoff / configuration-resolution service (deep module).** The service that already resolves which model a Cursor-backed run uses is extended to resolve effort the same way and pass it to the Cursor SDK alongside model. This service becomes the single authority for effort: it resolves the value server-side and ignores any effort value a client attempts to supply on kickoff, on a later turn, or on an artifact-create request.

- **Server-set module identity.** Each calling service that builds a kickoff — Interview, PRD, ADR, Design Doc, Standup, Feature Request, and the rest, plus the Agent Home skill-pill handler — sets an internal module identifier on the kickoff object it constructs. The browser never supplies or can override this identifier. The kickoff/configuration-resolution service uses it to select which module's effort override applies, the same way a server-set module identity would be required for model if a client could otherwise spoof it.

- **Artifact creation paths.** Interview, PRD, ADR, Design Doc, and Design Prototype creation already snapshot the resolved model on the artifact row at creation time. Each is extended to snapshot the resolved effort in the same write, using the same value the kickoff/configuration-resolution service passed to the Cursor SDK for that run. Design Prototype snapshotting applies only when the project's prototype engine is the agent path; the Bedrock prototype path is unaffected.

- **Usage/cost recording service (deep module).** The service that already writes one usage/cost row per AI interaction — model, tokens, cost — is extended to include the resolved effort on the same row, for every Cursor-backed module, including modules that have no dedicated artifact table to snapshot onto (Standup, Feature Request, Technical, Issue, Calendar Assistant, Load Test Generation, Design Module, Design Module Scoping).

- **Admin settings UI.** The existing per-module model-override screen gets one additional control per module: an effort selector with an explicit "Inherit" option, saved through the same validate/save path as the model control. No new settings screen.

- **Artifact headers and cost views.** The existing places that already display the snapshotted model — artifact headers and cost-history rows/detail — show effort next to it when present. Nothing new is shown when the value is null.

## Testing Decisions

- **What makes a good test here:** Tests should prove observable behavior, not internals: (a) an admin-configured per-module effort is the value that actually reaches the Cursor SDK for that module's run, regardless of any effort value a client attempts to send; (b) the resolved value is snapshotted on the artifact and the usage event, and stays fixed for the rest of an in-flight thread even if the admin default changes mid-conversation; (c) an invalid value is rejected at save time with a clear error, and an unexpected or corrupted stored value is treated as absent at run time without failing the run.
- **Modules to test:**
  - The configuration-resolution path (module override → project default → omit) — this is the single source of truth for what value reaches the SDK, so its branching needs direct coverage.
  - The kickoff/create paths for at least two representative modules (for example Interview and ADR) — proves the server-set module identifier and effort resolution generalize beyond one caller instead of being special-cased.
  - The admin settings write path — proves the allow-list validation rejects bad input before it can ever reach a kickoff.
- **Prior art:** The existing per-module model-override tests (admin settings write/read, and the artifact-model-audit snapshot tests already covering Interview and PRD) assert that a configured value flows unchanged through settings → kickoff → snapshot. The effort case should extend those same tests in parallel rather than create a new, separate test file per module.

## Target Surface

- **Primary surface:** Full-stack (both client and server)
- **Experience notes:** The only new UI is one effort selector per module inside the existing Admin → Project Settings screen. Artifact headers and AI Cost Analytics gain a small "effort" label next to the existing model label; no new pages, routes, or navigation entries.

---

## Access Control and Permissions

| Action | Required group(s) / role(s) | Data scope |
|--------|---------------------------|-----------|
| Set or change a module's default effort | Project Admin (`admin:roles`) | Project-scoped |
| Start a module and have its configured default effort applied | Whoever already starts that module — BA, Product-Owner, or Manager (Interview); Developer (ADR, Development); Authenticated User (Agent Home chat, Feature Request); and the other existing create/run permissions per module | Project-scoped |
| View the snapshotted effort on an artifact | Whoever already opens that Interview, PRD, Design Doc, or Design Prototype | Project-scoped |
| View effort on cost history | Users with `analytics:ai-cost:view` | Project-scoped |

---

## Security and Data Sensitivity

- **Sensitive fields:** None. Effort is operational metadata — a short label describing reasoning effort — the same class of field as the existing model identifier.
- **Handling requirements:** None beyond what already applies to model: no encryption, masking, or redaction. Effort is visible to anyone who can already see the artifact or cost row it is attached to.
- **Data scope enforcement:** Unchanged. Effort rides on the same project-scoped rows (`project_skill_settings`, artifact tables, `ai_usage_events`) that already enforce project scoping for model; no new enforcement surface is introduced.

---

## Non-Functional Requirements

- **Response time:** Matches the existing model-override envelope — admin settings read/write stay in the current sub-1-second range; kickoff, artifact create, and usage-event recording add one extra field and must not add a user-visible delay beyond today's model pass-through.
- **Concurrency:** Matches existing Project Settings write concurrency (a handful of Project Admins per project) and existing module kickoff volume. No new fan-out.
- **Data volume:** One nullable short-text column per module on `project_skill_settings`, one per artifact snapshot, one per `ai_usage_events` row. No backfill. No new index unless cost dashboards later need to filter by effort.

---

## Feature Flag

- **Flag required:** No
- **Flag name:** None
- **Rollout sequence:** GA from launch
- **Kill switch owner:** Not applicable
- **Behavior when disabled:** Not applicable — null/Inherit is the default for every module until a Project Admin sets a value, so existing behavior is unchanged until an admin opts in.

---

## Out of Scope

- A runtime effort picker for end users on interview start, Agent Home, or any other kickoff surface — defaults are admin-only
- Effort support for Bedrock-only stages (PRD review, Design Prototype/UI Lab Bedrock generation, Design Plan) — those keep their existing max-tokens/timeout/temperature knobs
- New skill files, new services, or new SSE event/streaming types for effort-aware runs
- New RBAC permission keys — writes stay on `admin:roles`; runtime apply and audit/cost reads stay on each module's existing permissions
- Backfilling effort onto artifacts or usage events created before this feature ships

## Assumptions Made

- The Cursor SDK effort argument accepts exactly `low`, `medium`, and `high`; if the SDK's actual allow-list differs, the shared effort type must be corrected to match before this ships.
- ADR already snapshots model on its artifact row in the current schema, so ADR is included in the artifact-snapshot scope alongside Interview, PRD, Design Doc, and Design Prototype.
- Design Prototype gets an effort default only for the agent-engine path (`prototypeEngine` = `agent`); the Bedrock-engine prototype path is out of scope and keeps its existing knobs.
- Stages with no dedicated artifact-audit column (Standup, Feature Request, Technical, Issue, Calendar Assistant, Load Test Generation, Design Module, Design Module Scoping) still get a usage-event effort column; there is no artifact row for those to snapshot onto.
- No feature flag key is needed because Project Settings writes are already gated by `admin:roles` and a null/Inherit default preserves today's behavior until a Project Admin opts in.
