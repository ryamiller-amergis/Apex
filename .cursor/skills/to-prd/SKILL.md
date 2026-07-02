---
name: to-prd
description: Reads .ai-pilot/kickoff-transcript.md and silently synthesizes a PRD markdown file and an SDLC backlog JSON file written to .ai-pilot/output/. Use when the user says /to-prd, "create a PRD", "turn this into a PRD", or wants to formalize a feature discussion into structured requirements.
---

# to-prd

Reads `.ai-pilot/kickoff-transcript.md` and produces two artifacts — a PRD markdown file and an SDLC backlog JSON file — written to `.ai-pilot/output/`. Do NOT ask the user any questions. Synthesize entirely from the transcript and codebase exploration.

## Phase 1 — Load inputs

Read each of the following before writing anything:

1. [`.ai-pilot/kickoff-transcript.md`](../../../.ai-pilot/kickoff-transcript.md) — **sole requirements input**; treat every statement here as the authoritative scope
2. [`context.md`](../../../context.md) — product context guide and terminology; use Apex terms consistently (Interview, PRD, Design Doc, Design Prototype, PBI, TBI, Feature Flag, Skill, etc.)
3. [`AGENTS.md`](../../../AGENTS.md) — feature map, directory structure, service boundaries
4. [`.cursor/skills/to-prd/backlog-schema.json`](backlog-schema.json) — JSON Schema to self-validate the backlog output against

Then explore the relevant parts of the codebase to understand current state. Sketch the major modules to build or modify. Identify which are deep modules (encapsulate significant logic behind a simple interface) vs. shallow modules. Prefer deep modules — they are easier to test in isolation.

## Phase 2 — Write artifacts (silent — no user interaction)

Derive a `{kebab-slug}` from the PRD title (lowercase, hyphens, no special characters).

Ensure the `.ai-pilot/output/` directory exists, then produce both files **in this order** — the PRD is the authoritative narrative; the backlog is a structured projection of the same scope:

| Step | Action | Purpose |
|------|--------|---------|
| 2a | **Structural plan** (internal — do not write a file) | From the transcript, sketch epics → features → PBIs/TBIs, persona mapping, and rollout decisions. Resolve broad-scope persona language before writing either artifact. |
| 2b | Write `.ai-pilot/output/{kebab-slug}.prd.md` | PRD narrative — use [`prd-template.md`](prd-template.md). **Owns** problem/solution, implementation/testing decisions, target surface, security, NFRs, **feature-flag decision**, **assumptions**, and out-of-scope narrative. **Does NOT author user stories** (projected from backlog at view time). |
| 2c | Write `.ai-pilot/output/{kebab-slug}.backlog.json` | Structured SDLC backlog — must validate against [`backlog-schema.json`](backlog-schema.json); see [`backlog-example.json`](backlog-example.json) for shape. **Derived from the PRD + structural plan.** **Owns** epics/features/PBIs/TBIs, **user stories**, acceptance criteria, business rules, dependencies, and feature-flag **name** (only when the PRD says a flag is required). |
| 2d | **Reconcile pass** (mandatory) | Re-read both files and fix any drift before finishing (see **Cross-file consistency checks**). |

**Backlog-from-PRD rule:** Every epic, feature, and PBI/TBI in the backlog must trace to content in the PRD (`## Problem Statement`, `## Solution`, `## Implementation Decisions`, `## Testing Decisions`, `## Target Surface`, `## Out of Scope`). Do not add backlog-only scope — especially do not invent `featureFlag` entries, personas, or PBIs that have no basis in the PRD or transcript.

Do NOT ask any questions before, during, or after writing. Derive all decisions from the transcript and codebase.

## Output contract

> **Single-ownership model with PRD-first authoring.** The PRD is written first and is authoritative for narrative decisions (problem, solution, implementation/testing, target surface, security, NFRs, **feature-flag required/rollout/disabled behavior**, **assumptions**, out-of-scope intent). The backlog is written second and must be a faithful structural decomposition of that PRD plus the transcript. The backlog owns epics → features → PBIs/TBIs, **user stories**, acceptance criteria, business rules, dependencies, and feature-flag **name** (only when the PRD requires a flag). Each overlapping field has exactly one author; the other artifact either omits it or mirrors it without re-authoring.

### Backlog JSON (`.ai-pilot/output/{kebab-slug}.backlog.json`) — write after PRD
Follow [`backlog-schema.json`](backlog-schema.json). Key constraints:
- `priority` values must be exactly: `"Must Have"`, `"Should Have"`, `"Could Have"`, or `"Won't Have"`
- PBI `acceptanceCriteria` must include all four coverage scenarios: (a) happy path, (b) error/failure, (c) edge case/boundary, (d) negative scenario
- PBI `userStory.persona` must match a name from the Apex groups enum (`Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`) **and** must be listed on the parent Feature's `affectedPersonas`.
- Feature `description` and `affectedPersonas` must describe the **same audience** — use exact persona names from the enum; never generic labels ("User", "authenticated user", "all users").
- Every Feature's `items` array holds both PBIs and TBIs
- `assumptionsMade` at top level is a **faithful copy of the PRD's `## Assumptions Made`** — do not author assumptions independently in the backlog.
- **`featureFlag` is optional on each Feature.** Include it **only when** the PRD `## Feature Flag` section has **Flag required: Yes**. When the PRD says **Flag required: No**, **omit** the `featureFlag` property entirely.

### PRD (`.ai-pilot/output/{kebab-slug}.prd.md`) — write first
Follow [`prd-template.md`](prd-template.md) exactly. Key constraints:
- Frontmatter must include `triage-status: needs-triage` and `glossary-terms-used`
- **Do NOT author a `## User Stories` section** — user stories are owned by the backlog PBIs and projected read-only into the PRD view. The PRD markdown must not contain a duplicate authored copy.
- Implementation Decisions: **no file paths, no code snippets** — describe modules and interfaces only
- `## Assumptions Made` must be populated even if minimal. **The PRD is the sole author of assumptions**; the backlog's `assumptionsMade` mirrors this section.

## Quality gates (self-check before writing)

- [ ] `.ai-pilot/kickoff-transcript.md` was the sole requirements source
- [ ] No questions asked of the user at any point
- [ ] Apex terminology from `context.md` used consistently
- [ ] No invented personas without a flag in the PRD `## Assumptions Made`
- [ ] PRD does NOT contain an authored `## User Stories` section
- [ ] No file paths or code snippets in Implementation Decisions
- [ ] PBI AC covers all four required scenarios (a–d)
- [ ] Backlog JSON field names match `backlog-schema.json` required properties
- [ ] Every PBI has a unique `id` matching `PBI-NNN`; every TBI has a unique `id` matching `TBI-NNN`
- [ ] `dependsOn` arrays reference only IDs that exist in the same backlog (no dangling references)
- [ ] `dependsOn` graph is a valid DAG — no cycles
- [ ] `triage-status: needs-triage` present in PRD frontmatter
- [ ] Both files written to `.ai-pilot/output/`
- [ ] `## Target Surface` section present; surface label matches the backlog PBI content
- [ ] `## Access Control and Permissions` section present with at least one action row
- [ ] `## Security and Data Sensitivity` section present
- [ ] `## Non-Functional Requirements` section present
- [ ] `## Feature Flag` section present; all five fields populated

### Cross-file consistency checks (mandatory reconcile pass — Phase 2d)

Run every check below; fix both files if needed before finishing:

- [ ] **Scope traceability:** Every Feature and PBI/TBI in the backlog maps to something stated or implied in the PRD. Remove backlog-only items that the PRD does not cover.
- [ ] Every PBI `userStory.persona` matches a name from the Apex groups enum
- [ ] Every PBI `userStory.persona` is included in its parent Feature's `affectedPersonas`
- [ ] No Feature `description` uses generic user labels — beneficiaries match `affectedPersonas` verbatim
- [ ] **Feature flag alignment (bidirectional):**
  - PRD **Flag required: Yes** → every affected Feature has `featureFlag.name` matching the PRD flag name
  - PRD **Flag required: No** → **no** Feature has a `featureFlag` property
- [ ] The PRD `## Out of Scope` and the backlog `outOfScope` arrays are consistent
- [ ] `assumptionsMade` in the JSON is a faithful copy of `## Assumptions Made` in the PRD
