---
name: design-spec-review
description: Evaluates prd-design-spec output against a weighted rubric, emits a confidence scorecard, surfaces remediation questions for gaps, and patches files in-place after user answers. Use when the user says /design-spec-review {slug} or wants a quality gate before work items are created.
---

# Design Spec Review — Foundation

Scores the `prd-design-spec` output (design doc, tech spec, assumptions) against a weighted rubric.

## Inputs

Read all design spec files for the slug from `.ai-pilot/output/{slug}-design-spec/`:
- `{feature-slug}-design.md`
- `{feature-slug}-tech-spec.md`
- `{feature-slug}-assumptions.md`

## Scoring

Use the project rubric (`rubric.md` from adapter or foundation). Emit a scorecard (using `scorecard-template.md`) per Feature:

- Score each section 0–2.
- Weight sections per the rubric.
- Flag any section scoring 0 or 1 as requiring remediation.

## Remediation Q&A

For each section scoring 0 or 1, ask one targeted question to fill the gap. Apply answers in-place to the affected artifact file.

## Re-score

After applying all remediations, re-score and show the before/after comparison.

## Confidence scorecard output

Emit a human-readable scorecard plus a machine-readable `.ai-pilot/output/{slug}-design-spec-review.json` with final scores.

## Quality gates (self-check before reporting)

- [ ] Every artifact file was read and scored
- [ ] Section scores match the rubric criteria
- [ ] Before/after re-score shown
- [ ] Machine-readable scorecard written
