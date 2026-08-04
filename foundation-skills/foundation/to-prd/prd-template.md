---
title: <PRD Title>
slug: <kebab-slug>
created: <YYYY-MM-DD>
triage-status: needs-triage
glossary-terms-used:
  - <term from context.md>
---

# <PRD Title>

## Problem Statement

<The problem that the user is facing, from the user's perspective. Describe the pain, friction, or gap — not the solution. 2–4 sentences.>

## Solution

<The solution to the problem, from the user's perspective. Describe the end state — not the implementation. 2–4 sentences.>

<!--
User stories are intentionally NOT authored here. They are owned by the SDLC backlog
({slug}.backlog.json) as PBI `userStory` objects, and the Apex PRD view renders them
read-only by projecting from the backlog at view time. Do not add a `## User Stories`
section to this template or to generated PRDs.
-->

## Implementation Decisions

A list of implementation decisions made during synthesis. Include:

- The modules that will be built or modified (no file paths, no code snippets)
- The interfaces of those modules (inputs, outputs, side effects — described in prose)
- Technical clarifications from the conversation
- Architectural decisions (layer boundaries, service patterns)
- Schema changes (table names, column intent — no DDL)
- API contracts (endpoint intent and shape — no code)
- Specific interactions (how components coordinate)

> Deep modules — those that encapsulate significant logic behind a simple, stable interface — are preferred over shallow modules. Flag any module identified as a deep module with "(deep module)".

## Testing Decisions

- **What makes a good test here:** <Only test external behavior, not implementation details. Describe what the observable behavior is that tests should prove.>
- **Modules to test:**
  - <Module name> — <reason>
- **Prior art:** <Existing test patterns in the codebase that are similar in structure or purpose — describe the pattern, not the file path.>

## Target Surface

- **Primary surface:** {Frontend only (React client) | Backend only (Express server) | Full-stack (both client and server) | Shared types only | Database migration only}
- **Experience notes:** {Any relevant notes about the user experience or "Not applicable"}

---

## Access Control and Permissions

| Action | Required group(s) / role(s) | Data scope |
|--------|---------------------------|-----------|
| {action} | {group or RBAC role} | {Project-scoped | User-scoped | Global | No restriction} |

<!-- At least one row required. -->

---

## Security and Data Sensitivity

- **Sensitive fields:** {List fields with sensitivity classification, or "None"}
- **Handling requirements:** {Encrypt at rest | Mask in logs | Exclude from API responses | Combination — describe | None}
- **Data scope enforcement:** {How the system ensures a user cannot access another project's data — or "Not applicable"}

---

## Non-Functional Requirements

- **Response time:** {e.g., "Primary action completes within 2 seconds at P95" — or "Not specified — agent assumed reasonable default based on similar features"}
- **Concurrency:** {e.g., "Supports up to 100 simultaneous users without degradation" — or "Not specified"}
- **Data volume:** {e.g., "Query returns up to 500 records; pagination required above 50" — or "Not specified"}

---

## Feature Flag

> **Authoritative for backlog `featureFlag`.** If **Flag required: No**, the backlog must **not** include a `featureFlag` property on any Feature. If **Flag required: Yes**, every affected Feature in the backlog must include `featureFlag.name` matching this section.

- **Flag required:** {Yes | No}
- **Flag name:** {kebab-case key when Yes | None when No}
- **Rollout sequence:** {Internal → Beta → GA | GA from launch | Not applicable}
- **Kill switch owner:** {Team or role responsible for disabling if needed — or "Not applicable"}
- **Behavior when disabled:** {What the user sees or experiences when the flag is off — or "Not applicable"}

Use **Flag required: No** for small UI defaults, bug fixes, and changes that ship GA without controlled rollout.

---

## Out of Scope

- <Explicit exclusion — at least one item required>

## Assumptions Made

- <Every inference made during synthesis that should be confirmed with stakeholders>
