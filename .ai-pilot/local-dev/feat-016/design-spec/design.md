# Design — Role Skill Set

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Agent Guidance and Knowledge Base | **Affected personas:** Developer, QA, UI/UX, Platform Admin
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (3 unresolved)

---

## Feature Summary

**Description:** Agents that build from a single prompt need one approved Skill per role, or each build invents its own process. This Feature (FEAT-016) adds five role Skills to the Full-Stack Express Starter Template: planner, UI, developer, QA, and integration. A Developer gets a plan grounded in the repository and a development agent that loads the right standards. QA gets a gate-by-gate evidence report. UI/UX gets screens built from the design system. Platform Admin gets a readiness report that names every gap and open decision before a build enters the pipeline. The end state is five Markdown Skills that name inputs, outputs, and stop conditions, link from the agent entry point and agent index, and point only to files that exist in the template.

**Feature:** FEAT-016 | **Depends on (declared):** FEAT-012 (Quality Manifest and NFR Manifest), FEAT-015 (API-Contract and UI-Standards Skills). ⚠ Feature dependencies: FEAT-014 and FEAT-017 are also required; see the assumptions file.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-037 | TBI | Author the planner skill | Must Have |
| TBI-038 | TBI | Author the UI skill | Must Have |
| TBI-039 | TBI | Author the developer skill | Must Have |
| TBI-040 | TBI | Author the QA skill | Must Have |
| TBI-041 | TBI | Author the integration skill | Must Have |
| PBI-035 | PBI | Have the development agent apply the right skills automatically | Must Have |
| PBI-036 | PBI | Plan a one-prompt build from repository references | Must Have |
| PBI-037 | PBI | Verify a build against the quality manifest | Must Have |
| PBI-038 | PBI | Confirm a build is ready for the pipeline | Must Have |
| PBI-039 | PBI | Have the UI specialist agent work within the design system | Should Have |

---

## Scope and Out-of-Scope

**In scope:**
- The planner Skill (TBI-037): reads the agent entry point, module maps, quality manifest, and NFR manifest, and produces a plan that names the modules touched, the applicable gates, and the NFR evidence required (PBI-036).
- The UI Skill (TBI-038): sends a UI specialist agent to the `ui-standards` Skill, the design-system reference, and the component catalog before it builds or changes a screen (PBI-039).
- The developer Skill (TBI-039): requires `api-contract` for endpoint work, `ui-standards` for screen work, a reviewed migration for schema changes, and the applicable quality gates for every change (PBI-035, BR-015).
- The QA Skill (TBI-040): reads the quality manifest and NFR manifest, runs or reviews each gate, and reports evidence per gate, with deferrals reported as not verified (PBI-037).
- The integration Skill (TBI-041): reads the quality manifest, the QA evidence, and the handoff document, and decides whether a build is ready for Platform Engineering's pipeline (PBI-038).
- For each Skill: a stated list of inputs, outputs, and stop conditions; a link from the agent entry point and the agent index; references only to files that exist in the template.
- Stop-and-report behavior when a required reference is missing, in every Skill that reads one.
- Plain Markdown and plain-text reports that agents and assistive tools can read, with no secrets or identity values.

**Out of scope:**
- Runtime AI services or model dependencies; the generated application has no AI runtime or SSE.
- Orchestration of agents, which Apex provides.
- Skills for work outside the template's stack.
- Prompt authoring tools and project management integration.
- Writing new tests for project-specific Features, and manual exploratory testing.
- Running the pipeline and deploying to ECS; Platform Engineering owns both.
- Generating new visual designs and visual regression testing.
- Any change to Apex runtime behavior, its database, or its services.
- The `api-contract` and `ui-standards` Skills (FEAT-015), the knowledge base and validation script (FEAT-014), the manifests (FEAT-012), and the handoff document (FEAT-017); this Feature reads them and does not write them, except for adding link lines to the entry point and index and, if ⚠ Skill structure enforcement is decided that way, a rule block for the validation script.
- A role model, user list endpoints, or RBAC; BR-003 leaves these as an open extension point.

---

## Target Surface

**Primary surface:** Full-stack (both client and server)

**Experience notes:** This is the PRD label for the whole template. This Feature adds no screen, endpoint, or table. Its deliverable is five Markdown Skills in `templates/full-stack-express/` that guide agents building the template's full-stack code. The "users" are Developers, QA, UI/UX, and Platform Admin working through an agent. The template has no Apex navigation entry, so Apex's header, sidebar, and page shell stay as they are.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Run the planner Skill on a prompt | Developer, or a planning agent acting for one | Project-scoped (the repository that holds the template) |
| Run the developer Skill on a task | Developer, or an Apex-launched development agent acting for one | Project-scoped |
| Run the QA Skill against a build | QA, or a QA agent acting for one | Project-scoped |
| Run the UI Skill on a screen task | UI/UX, or the UI specialist agent acting for one | Project-scoped |
| Run the integration Skill and read its readiness report | Platform Admin (stands in for Platform Engineering) | Project-scoped |
| Review the Skills and move the template to the bootstrap source | Platform Admin | Global |
| Role-based authorization inside generated applications | Not defined; RBAC is an extension point for Platform Engineering (BR-003) | Not applicable |

No Apex permission key, `can()` guard, or `requirePermission` check applies. Anyone who can read the template repository can read the Skills.

**Feature flag:** `None` — rollout: None
**Behavior when flag is off:** Not applicable. The PRD sets "Flag required: No", and the Skills change no Apex runtime behavior.

---

## Acceptance Criteria

Criteria come from the backlog. Rows marked "derived" fill a scenario type the backlog does not cover; see the assumptions file.

### PBI-035 — Have the development agent apply the right skills automatically

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path (endpoint) | A task adds or changes an endpoint | The developer skill runs | It directs the agent to the api-contract skill before any code is written |
| (a2) Happy path (screen) | A task adds or changes a screen | The developer skill runs | It directs the agent to the ui-standards skill before any code is written |
| (b) Error/failure | A required reference file is missing | The developer skill runs | The agent stops and reports the missing reference instead of guessing |
| (c) Edge case/boundary | A task changes only documentation or configuration | The developer skill runs | It does not require either skill but still requires the applicable quality gates |
| (d) Negative scenario (derived) | A change would put a hard-coded secret or identity value in code or tests | The developer skill runs | The skill forbids it, and the agent uses a synthetic value or an environment variable instead |

### PBI-036 — Plan a one-prompt build from repository references

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A prompt describes a feature | The planner skill runs | The plan names the modules touched, the applicable quality gates, and the NFR evidence needed |
| (b) Error/failure (derived) | The entry point, a module map, or a manifest cannot be read | The planner skill runs | The skill stops, names the missing path, and produces no plan |
| (c) Edge case/boundary | The NFR manifest has only illustrative values | The planner skill runs | The plan states that real targets are missing instead of using the examples |
| (d) Negative scenario | A prompt asks for work that is out of the template's scope, such as AWS infrastructure | The planner skill runs | The plan marks it as owned by Platform Engineering and excludes it |
| (d2) Negative scenario | A prompt asks for a user list or role-based access | The planner skill runs | The plan flags the open RBAC decision and does not invent a role model |

### PBI-037 — Verify a build against the quality manifest

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | All gates pass | The QA skill runs | The report lists each gate with evidence of its result |
| (b) Error/failure | A gate fails | The QA skill runs | The report names the failing gate and its output and does not report the build as verified |
| (c) Edge case/boundary | A gate is deferred with a reason | The QA skill runs | The report lists it as not verified, with the reason and owner |
| (d) Negative scenario | A referenced gate script is missing | The QA skill runs | The report flags a manifest error and stops |

### PBI-038 — Confirm a build is ready for the pipeline

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | Every gate has passing evidence or a recorded deferral | The integration skill runs | It reports the build as ready and lists the deferrals |
| (b) Error/failure | A required gate has no evidence | The integration skill runs | It reports the build as not ready and names the gate |
| (c) Edge case/boundary | The handoff document lists open decisions that affect the build | The integration skill runs | It lists those decisions in its report |
| (d) Negative scenario | The build contains the development authentication adapter selected for production | The integration skill runs | It reports the build as not ready |

### PBI-039 — Have the UI specialist agent work within the design system

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | The UI specialist agent builds a screen | It follows the UI skill | It lists the catalog components and theme tokens it reused |
| (a2) Happy path (states) | The screen has loading, empty, error, and loaded states | The agent finishes | It provides evidence from component and accessibility tests for each state |
| (b) Error/failure | The agent cannot read the design-system reference | It starts the task | It stops and reports the missing reference |
| (c) Edge case/boundary | The agent needs a component the catalog lacks | It follows the UI skill | It proposes a catalog addition and does not create a one-off styled component |
| (d) Negative scenario (derived) | One of the four states has no component or accessibility test evidence | The agent finishes | It does not report the screen as done and names the state that lacks evidence |

---

## UI/UX

Not applicable. This Feature adds no route, screen, component, or `data-testid` attribute to Apex or to the template. The UI Skill (TBI-038) and PBI-039 govern screens that agents build in generated projects. Those screens follow the `ui-standards` Skill (FEAT-015) and the FEAT-009 and FEAT-010 design system.

Accessibility applies to the Skills themselves (NFR on PBI-035 to PBI-039):
- Every Skill is plain Markdown with a heading hierarchy, descriptive link text, and no information carried by color or images alone.
- QA and integration reports are plain text, so a screen reader or an agent reads them the same way.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
