# Design — API-Contract and UI-Standards Skills

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Agent Guidance and Knowledge Base | **Affected personas:** Developer, UI/UX
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (4 unresolved)

---

## Feature Summary

**Description:** Projects built from the Full-Stack Express Starter Template need one way to add an endpoint and one way to build a screen, or each developer and each agent will invent its own. This Feature adds two Markdown skills to the template, `api-contract` and `ui-standards`. Each skill lists its rules, names the check that enforces every rule (or says review enforces it), and gives a step list for adding an endpoint or a screen. A developer or a development agent who follows a skill produces work that passes the template's drift, contract, accessibility, and component checks. A UI/UX reviewer gets a written checklist, so design consistency does not depend on who built the screen.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-035 | TBI | Author the api-contract skill | Must Have |
| TBI-036 | TBI | Author the ui-standards skill | Must Have |
| PBI-032 | PBI | Add an endpoint that follows the API contract rules | Must Have |
| PBI-033 | PBI | Build a screen that follows the UI standards | Must Have |
| PBI-034 | PBI | Review a screen against the UI standards checklist | Should Have |

**Dependencies:** FEAT-004 (Zod-Authoritative API Contract), FEAT-009 (Neutral MUI Design System and App Shell), FEAT-014 (Docs-as-Code Knowledge Base). The skills describe the finished modules of those Features, so they are written after them.

---

## Scope and Out-of-Scope

**In scope:**
- The `api-contract` skill (TBI-035). It covers Zod route definitions as the source of truth, the generated and drift-checked OpenAPI 3.1 document, resource-oriented HTTP semantics, versioned routes, RFC 9457 Problem Details errors with the request ID, bounded pagination, authentication boundaries, and contract tests.
- A step list in `api-contract` for adding an endpoint (PBI-032).
- A rule in `api-contract` that handlers must not accept another person's identifier on the profile resource.
- The `ui-standards` skill (TBI-036). It covers theme token use, component rules, responsive layout, loading, empty, and error states, accessibility, forms, query handling and invalidation, and stable test selectors.
- A step list in `ui-standards` for adding a screen (PBI-033), and the test selector, form, and query patterns that the profile screen uses.
- A written review checklist in `ui-standards` that a UI/UX reviewer applies to a screen (PBI-034).
- In both skills, a rules table in which every rule names its enforcing check or states "Review".
- Links to both skills from the agent entry-point document and the agent index.

**Out of scope:**
- Skills for infrastructure or pipelines.
- Apex-specific skills, Apex names, paths, permission keys, and branding.
- Authorization rules and roles. The template defines none, and RBAC stays an extension point for Platform Engineering.
- Endpoint implementation for any specific project.
- Designing screens for a specific project, and brand-specific styling.
- Visual design of new components.
- Automated visual regression testing.
- Building the enforcing checks themselves (drift check, contract tests, accessibility checks, lint rules). Other Features own them; these skills only cite them. One gap is raised in the assumptions file: no work item builds the check that detects a handler with no route definition.
- The developer, planner, UI, QA, and integration role skills (FEAT-016), which link to these two skills.
- A runtime AI service, model dependency, or wiki service.

---

## Target Surface

**Primary surface:** Full-stack (PRD primary surface). The Feature ships Markdown files only. Its rules govern both the template's Express API and its React web client.

**Experience notes:** The readers are people and agents, not end users. Each skill is a plain Markdown file that an agent or an assistive tool can read without running anything. The Feature adds no Apex screen, navigation entry, or route. The only screen it refers to is the template's self-service profile screen (FEAT-010), which serves as the worked example.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Read and follow the skills in a generated project | Developer, including an Apex-launched development agent | No restriction |
| Review a screen against the UI standards checklist | UI/UX | No restriction |
| Review the template in Apex and move it to the bootstrap source | Platform Engineering (mapped to `Platform Admin`) | Global |
| Rules the skills impose on endpoints: authentication required on every non-health route | Authenticated principal from the identity-provider adapter; no roles defined | User-scoped |
| Rules the skills impose on health endpoints (`/health/live`, `/health/ready`) | None | No restriction |
| Role-based authorization in generated apps | Not defined; an extension point for Platform Engineering | Not applicable |

The skills are repository files. Access to them follows access to the generated project's repository. This Feature adds no Apex permission and no Apex RBAC change.

**Feature flag:** `None` — rollout: Not applicable (PRD: Flag required: No)
**Behavior when flag is off:** Not applicable

---

## Acceptance Criteria

### PBI-032 — Add an endpoint that follows the API contract rules

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I follow the skill to add an endpoint | I run the drift and contract checks | They pass with the new route documented |
| (b) Error/failure | I add a handler without a route definition | I run the checks | The checks fail and point to the undocumented route |
| (c) Edge case/boundary | My endpoint returns a list | I follow the pagination rules in the skill | The route defines a default and a maximum page size and rejects larger values with a Problem Details error |
| (d) Negative scenario | My endpoint returns an error body with a stack trace or identity value | I run the contract and error-handling tests | The tests fail |

### PBI-033 — Build a screen that follows the UI standards

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I follow the skill to add a screen | I run the accessibility and component tests | They pass for loading, empty, error, and loaded states |
| (b) Error/failure | My screen has a form field without a label | I run the accessibility check | The check fails and names the field |
| (c) Edge case/boundary | My screen fetches data | I follow the query rules in the skill | It uses the shared query client and invalidates affected queries after a change |
| (d) Negative scenario | My screen uses a hard-coded color or an unlisted component pattern | I review it against the skill checklist | The deviation is reported as a violation |

### PBI-034 — Review a screen against the UI standards checklist

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A new screen follows the standards | I review it with the checklist | Every checklist item can be marked as met with evidence from the design-system reference or tests |
| (b) Error/failure | A screen skips its empty or error state | I review it with the checklist | The missing state is identified as a failure |
| (c) Edge case/boundary | A screen is reviewed at the narrowest and widest supported widths | I use the checklist | It prompts me to confirm layout and focus order at both widths |
| (d) Negative scenario | A screen uses a component outside the documented catalog | I review it with the checklist | The component is flagged for catalog addition or replacement |

### TBI-035 and TBI-036 — definition of done, as reviewable criteria

| Item | Criterion |
|------|-----------|
| TBI-035 | The skill lists the rules and the enforcing check for each. It gives a step list for adding an endpoint. It states that handlers must not accept another person's identifier on the profile resource. It is linked from the agent entry point and the agent index. It states that undocumented or incompatible behavior fails the drift and contract checks. |
| TBI-036 | The skill lists the rules and the enforcing check for each. It gives a step list for adding a screen. It states the test selector convention and the form and query patterns used by the profile screen. It is linked from the agent entry point and the agent index. |

---

## UI/UX

Not applicable.

This Feature adds no Apex route, screen, or component, so there are no states, validation rules, or `data-testid` attributes to specify for Apex. The `ui-standards` skill itself defines the template's own screen rules. Their content, which UI/UX reviewers should check, is:

- **Review checklist groups:** theme tokens (no hard-coded color, spacing, or type), catalog components only, loading, empty, error, and loaded states, responsive layout at the narrowest and widest supported widths, keyboard operation and visible focus, labeled controls, contrast, screen-reader announcements, forms, query handling, and test selectors.
- **Evidence:** each checklist item names where evidence comes from, either the design-system reference, the component catalog, a component test, or an accessibility check result.
- **Accessibility target:** WCAG 2.1 AA, with automated axe checks on every screen state.
- **Selectors:** the skill states the test selector convention from the UI package and applies it to the profile screen as the example.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
