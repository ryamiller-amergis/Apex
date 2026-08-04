---
name: prd-spec-review
description: Evaluates to-prd output (PRD markdown and backlog JSON) against deterministic rubrics, emitting a confidence scorecard, surfacing remediation questions, and patching files in-place after user answers. Use when the user says /prd-spec-review {slug} or wants a quality gate before design-spec or implementation.
---

# PRD Spec Review — Foundation

Evaluates PRD + backlog output against deterministic rubrics.

## Inputs

1. Read `.ai-pilot/output/{slug}.prd.md`
2. Read `.ai-pilot/output/{slug}.backlog.json`
3. Load `rubric.md` (from adapter or foundation) for scoring criteria
4. Load `scorecard-template.md` for output format

## Scoring dimensions (PRD)

| Section | Weight | Pass criteria |
|---------|--------|---------------|
| Problem statement | 20% | Clear problem, scope, measurable user impact |
| Solution | 20% | Concrete approach, not just intent |
| Target surface | 10% | Frontend/backend/data explicitly identified |
| Acceptance criteria | 20% | Each PBI has ≥4 AC scenarios (happy/error/edge/negative) |
| Feature flag decision | 10% | Flag required/not required explicitly stated |
| Security and permissions | 10% | Auth and data sensitivity addressed |
| Assumptions | 10% | Explicit, verifiable, populated |

## Scoring dimensions (Backlog JSON)

Validate the backlog JSON against the project's `backlog-schema.json`:
- All required fields present
- Persona enum values match the project's allowed values
- All Feature `dependsOn` references resolve
- `implementationPhases` assigns every epic to exactly one phase
- PBI AC coverage: (a) happy path (b) error (c) edge (d) negative

## Remediation Q&A

For each section scoring < threshold, ask one targeted question. Apply user answers in-place.

## Output

1. Human-readable scorecard with section scores, total score, and pass/fail
2. `.ai-pilot/output/{slug}-prd-review-scorecard.json` (machine-readable)
3. Patched files with remediation content applied

## Quality gates

- [ ] Every section scored per rubric
- [ ] Backlog JSON validated against schema
- [ ] Scorecard written
- [ ] Files patched with remediation content
