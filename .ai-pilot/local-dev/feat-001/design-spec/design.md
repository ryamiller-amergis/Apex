# Design — Evaluation Data Model and Contracts

> **PRD slug:** `human-workflow-evaluation-for-interviews-and-prds` | **Priority:** Must Have | **Feature flag:** `workflow-human-evaluation`
> **Parent Epic:** Evaluation Foundations | **Affected personas:** Product-Owner, BA, Manager, Developer, Project Admin, Platform Admin
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (4 unresolved)

---

## Feature Summary

**Description:** Apex has no place to store a reviewer's judgment of AI output. This Feature adds that place: three database tables, four seeded rubric definitions and one shared set of types. Product-Owner, BA, Manager and Developer users get a stable store for their feedback. Project Admin and Platform Admin users get records that cannot change after submission, so they can trust what they review. No screen or endpoint ships here. Every later Feature in the Human Workflow Evaluation epic reads or writes through these tables and types.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-001 | TBI | Create evaluation definitions, events and jobs tables | Must Have |
| TBI-002 | TBI | Seed platform evaluation definitions | Must Have |
| TBI-003 | TBI | Define shared evaluation types | Must Have |

There are no PBIs in this Feature. Acceptance criteria below are written per TBI.

---

## Scope and Out-of-Scope

**In scope:**
- Three tables: definitions (platform rubric versions), events (one immutable row per human submission) and jobs (one row per event and diagnostic evaluator).
- Database guards that keep events append-only and definitions unchanged except for the `active` flag.
- Four active seeded definitions under process `orchestrated_workflow`: PRD human review and Interview phases 1 to 3.
- A shared TypeScript module, used by client and server, for outcomes, reason codes, criteria scores, definitions, events, the create request, job status and the structured judge output.
- Drizzle schema entries that match the migrations.

**Out of scope:**
- Denormalized latest-review columns on PRDs or Interviews. This Feature adds no column to either table.
- Project-specific definition overrides. Definitions are platform seeds shared by every project (BR-015).
- Any endpoint, service, permission key or feature flag registration. Those belong to FEAT-002 and FEAT-003.
- Any screen, banner, modal or admin page.
- The artifact hashing algorithm, lineage resolution, reviewer role derivation and submission rules. These belong to the evaluation service in FEAT-003.
- Promptfoo suite files and the judge and Promptfoo executors. This Feature stores only the suite reference.
- Retention, redaction or classification rules for evaluation data.

---

## Target Surface

**Primary surface:** Database migration plus shared types. The only runtime code is the Drizzle schema entries, which are server-side.

**Experience notes:** Not applicable. The seeded wording below is what later screens show reviewers.

---

## Access Control

This Feature adds no route, so it enforces no permission itself. It stores `project` on every event, and later Features use it to scope reads and writes. The table shows who may act on this data once the later Features ship.

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| View definitions, event history and job diagnostics on an artifact | Holders of `workflow-evaluation:view` (default grants for Product-Owner, BA, Manager, Developer) | Project-scoped |
| Submit a human evaluation | Holders of `workflow-evaluation:submit` (default grants for Product-Owner, BA, Manager, Developer) | Project-scoped |
| Open the Workflow evaluations page, filter, export and retry failed jobs | Anyone who can open Project Admin for the project, or Platform Admin | Project-scoped |
| View the cross-project hub | Platform Admin | Global |
| Read seeded definitions | Any caller that passes the later router's checks. Definitions are platform seeds, not project data | Global (shared seeds) |

**Feature flag:** `workflow-human-evaluation` — rollout: Internal → Beta → GA (Apex project and named pilot projects first, then wider through Platform Admin targeting)
**Behavior when flag is off:** The three tables and four seeded rows exist and stay empty of events. No code in this Feature runs at request time, so the flag does not gate it. Later Features hide every feedback surface and refuse evaluation routes. Interview, PRD review and approval behave as they do today.

---

## Acceptance Criteria

### TBI-001 — Create evaluation definitions, events and jobs tables

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A clean test database with all earlier migrations applied | The tables migration runs | `workflow_evaluation_definitions`, `workflow_evaluation_events` and `workflow_evaluation_jobs` exist. Jobs are unique on event and evaluator. Indexes cover project, subject type, subject id and artifact hash. The Drizzle schema exports the same columns. |
| (b) Error/failure | An events row exists, and a job exists for an event and evaluator | A caller runs `UPDATE` or `DELETE` on the events row, or inserts a second job for the same event and evaluator | The database rejects each statement and the events row is unchanged. |
| (c) Edge case/boundary | The tables exist | Rows are inserted with `phase_index` 0, 1, 3 and 4; a PRD subject with `phase_index` 2; an `artifact_hash` of 63 characters and of 64 lowercase hex characters; an event with both a corrected-artifact text and a Blob reference. Then the migration rolls back and applies again. | Phase 1 and 3 on an Interview phase subject are accepted. Phase 0, phase 4, a PRD with a phase, a 63-character hash and the two-field correction are rejected. The rollback removes all three tables and their functions cleanly, and the second apply succeeds. |
| (d) Negative scenario | The migration has run | The column lists of `prds` and `interviews` are compared before and after, and the source is scanned for code that updates or deletes events | `prds` and `interviews` are unchanged, and no code path in `src/server` updates or deletes an events row. |

### TBI-002 — Seed platform evaluation definitions

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | The tables migration and the seed migration have both run | The definitions table is read | Exactly four rows are active under process `orchestrated_workflow`: `prd_human_review`, `interview_phase_1`, `interview_phase_2` and `interview_phase_3`. Each holds the same five criteria keys, the seven reason codes, the four outcomes, the six reviewer roles, a minimum low-score comment length, a Promptfoo suite reference and a judge output schema. |
| (b) Error/failure | The four seeded rows exist | A caller inserts a second active row with the same process, stage, evaluator and benchmark, or edits the rubric of an existing row | The database rejects both. Only the `active` flag can change on an existing row. |
| (c) Edge case/boundary | The seed migration has already run | The seed statements run a second time; later, a version 2 row is inserted for one stage and version 1 is set inactive | The second run adds no rows and raises no error. After the version bump, one row is active for that stage, version 1 is kept, and an event that pointed at version 1 still points at it. |
| (d) Negative scenario | The seed migration source and the definitions table | Both are inspected | The table has no project column, so no project-specific row can exist. The seed migration contains no `UPDATE` of an existing row's rubric, so it cannot rewrite history. |

### TBI-003 — Define shared evaluation types

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | `src/shared/types/workflowEvaluation.ts` exists | The server and client TypeScript builds run | Both compile. The router and UI Features import these types and define none of their own. A sample judge output validates against the seeded judge schema. |
| (b) Error/failure | A judge output that omits `confidence`, or has an `alignmentScore` of 7 | The judge output guard runs | The guard returns false and names no partial result as valid. |
| (c) Edge case/boundary | A judge output with empty finding arrays and no `alignmentScore`; others with `alignmentScore` 1, 5, 0 and 6 | The judge output guard runs | The empty output is valid. Scores 1 and 5 are valid. Scores 0 and 6 are invalid. |
| (d) Negative scenario | Code that builds a create request with `skillPath`, `skillVersion`, `model`, `interviewId`, `prdId` or `artifactHash` | The code is type-checked | Each assignment is a compile error, because the create request type holds no lineage or hash field. |

---

## UI/UX

Not applicable. This Feature ships no screen, route or component, so there are no `data-testid` attributes.

The seeded wording below is the product-visible content of this Feature. FEAT-004 and later screens render it from the definitions, so a copy change after release is a new definition version, not a code change. Product should review it before the seed migration is written.

**Score scale (all stages):** 1 Missed · 2 Major changes needed · 3 Some changes needed · 4 Minor changes needed · 5 Met completely

**Outcomes (all stages):** Accept unchanged · Accept after edits · Regenerate · Reject

**Reason codes (all stages):** Missing requirement · Invented requirement · Incorrect interpretation · Too vague · Wrong scope · Acceptance criteria not testable · PRD and backlog inconsistency

**Reviewer roles (all stages):** Product owner · BA · Manager · Developer · QA · Other

**Low-score rule:** A score of 2 or lower on any criterion requires at least one reason code and a comment of at least 20 characters. The comment length is a seed value that product must confirm.

**Criteria wording**

| Criterion key | Label | PRD human review help text | Interview phase help text |
|---------------|-------|----------------------------|---------------------------|
| `intent_alignment` | Intent alignment | Does the PRD state the problem and outcome you meant? | Does this phase capture the problem and outcome you meant to explore? |
| `requirements_coverage` | Requirements coverage | Does the PRD and Backlog include every requirement you expected? | Did this phase surface every requirement you discussed? |
| `scope_alignment` | Scope alignment | Does the PRD stay inside the scope you agreed, with nothing invented? | Did this phase stay inside the scope you agreed? |
| `acceptance_criteria` | Acceptance criteria | Can a tester check each acceptance criterion? | Are the success conditions in this phase specific enough to test? |
| `readiness` | Readiness | Could the team start design and delivery from this PRD without rework? | Is this phase complete enough to move to the next one? |

The three Interview phase stages use the Interview wording until product supplies phase names (see the unresolved item in the assumptions file). A one-phase Interview uses `interview_phase_1` only.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
