---
name: create-test-case
description: Derives senior-QA test cases from a backlog JSON with full traceability to PBIs, acceptance criteria, and business rules. Writes testCaseCount per PBI back into the backlog JSON. Use when the user says /create-test-case {slug} or wants QA test coverage before implementation.
---

# Create Test Case — Foundation

Derive comprehensive QA test cases from a reviewed SDLC backlog JSON, with full traceability to every PBI's acceptance criteria, business rules, and NFRs.

## Inputs

1. Read `.ai-pilot/output/{slug}.backlog.json` — the source of truth for PBIs, acceptance criteria, and business rules.
2. Read the project's `test-case-schema.json` (from adapter or foundation) to validate output.
3. Optionally read the PRD (`.ai-pilot/output/{slug}.prd.md`) for NFR context.

## Process

For each PBI in the backlog:

1. Read all acceptance criteria, business rules, and NFRs.
2. Derive test cases covering:
   - (a) Happy path — the expected success scenario
   - (b) Error/failure — system failure or invalid input
   - (c) Edge case/boundary — limits, empty states, maximum values
   - (d) Negative scenario — unauthorized access, missing data, wrong type
3. Assign a unique `id` (`TC-PBI-NNN-001`, `TC-PBI-NNN-002`, …).
4. Record the linked AC id and PBI id in each test case.
5. Classify automation tier: `unit`, `integration`, `api`, `e2e-playwright`, or `manual`.

## Output

1. Write `.ai-pilot/output/{slug}.test-cases.json` — validated against `test-case-schema.json`.
2. Write `.ai-pilot/output/{slug}.test-cases.md` — human-readable summary.
3. Patch the backlog JSON: update `testCaseCount` on each PBI.

## Quality gates

- [ ] Every PBI has at least one test case for each of the four AC coverage scenarios (a–d)
- [ ] Every test case traces to a PBI id and AC id
- [ ] No test cases invented without a basis in the backlog
- [ ] Output validates against `test-case-schema.json`
- [ ] `testCaseCount` updated in the backlog JSON
