---
name: to-prd
description: Reads a kickoff transcript (.ai-pilot/kickoff-transcript.md) and silently synthesizes a PRD markdown file and SDLC backlog JSON. Use when the user says /to-prd, "create a PRD", or wants to formalize a feature discussion into structured requirements.
---

# to-prd — Foundation

Reads `.ai-pilot/kickoff-transcript.md` and produces two artifacts: a PRD markdown and an SDLC backlog JSON. Do NOT ask questions. Synthesize from the transcript and codebase exploration.

## Linked context pre-read

If `.ai-pilot/linked-context.md` is present in the workspace, read it before proceeding. Treat its provenance-labeled sections as authoritative project grounding. If it is absent, proceed normally.

## Phase 1 — Load inputs

Before writing anything, read:

1. `.ai-pilot/kickoff-transcript.md` — sole requirements input
2. Project context and terminology from the project adapter (context guide + AGENTS.md equivalent)
3. The project's backlog schema (`backlog-schema.json` from the adapter or foundation) — self-validate against it
4. Relevant codebase to understand current state

## Phase 2 — Write artifacts

Derive a `{kebab-slug}` from the PRD title. Write both files to `.ai-pilot/output/` in this order:

| Step | Action | Purpose |
|------|--------|---------|
| 2a | Structural plan (internal) | Sketch epics → features → PBIs/TBIs, persona mapping, rollout decisions, and epic execution order |
| 2b | Write `.ai-pilot/output/{slug}.prd.md` | PRD narrative following the PRD template |
| 2c | Write `.ai-pilot/output/{slug}.backlog.json` | Structured SDLC backlog validated against the backlog schema |
| 2d | Reconcile pass | Re-read both files and fix drift |

## Output contract

**Single-ownership model:** The PRD is authoritative for narrative decisions (problem, solution, implementation, target surface, security, NFRs, feature-flag decision, assumptions, out-of-scope). The backlog is the structural decomposition of the PRD. Each overlapping field has exactly one author.

### PRD requirements

- Follow the project's `prd-template.md`
- Do NOT author a `## User Stories` section — user stories are owned by the backlog
- No file paths or code snippets in Implementation Decisions — describe modules and interfaces only
- `## Assumptions Made` must be populated

### Backlog JSON requirements

- Must validate against the project's `backlog-schema.json`
- Every epic must be assigned to exactly one implementation phase
- Backlog items must trace to PRD content — do not add backlog-only scope
- Feature `dependsOn` arrays reference only Feature IDs in the same backlog
- PBI `userStory.iWant` is a verb phrase the persona performs (e.g. "invite teammates"), never a system artifact (table, endpoint, helper)

## Quality gates

- [ ] Transcript was the sole requirements source
- [ ] No questions asked at any point
- [ ] No invented personas without a basis in the transcript
- [ ] PRD does NOT contain an authored `## User Stories` section
- [ ] No file paths or code snippets in Implementation Decisions
- [ ] Backlog JSON validates against the schema
- [ ] Both files written to `.ai-pilot/output/`
