---
name: design-doc-validation
description: Project adapter for design-doc-validation. Customize for your project.
---

# design-doc-validation — Project Adapter

<!-- Managed loader: loads .apex/foundation/design-doc-validation/SKILL.md -->
Binds the generic scoring engine to this project. Runs automatically — the
`documentValidationService` (or equivalent) launches it as an AI agent thread when
a design doc transitions to `validating`. No user interaction.

- Project: {{slot:projectName}}
- Output: `{{slot:aiPilotDir}}output/review-scorecard.json` and `review-scorecard.md`
- Consumer interface: `ValidationScorecard` (parsed by the validation service) — match exactly.

## Input context

Injected by the validation service: `doc_id`, Source PRD, Design,
Tech Spec, Assumptions. If Design, Tech Spec, and Assumptions are all empty,
write a scorecard with `overall_score: 0`, `is_ready: false`,
`verdict: "significant_gaps"` and stop.

## Canonical enums

Use this project's own persona, surface, and term vocabulary where defined (see
{{slot:agentsFile}} Key Terminology section). Ownership questions should reference
the project's own source layer locations (see {{slot:agentsFile}} Directory
Structure section). Answer only questions about THIS repository and project.

## Section rubrics and file weights

Score only the sections defined in `rubric.md` (design, tech spec, assumptions
tables). File weights: design 35%, tech-spec 45%, assumptions 20%. Run only the
cross-cutting checks listed in `rubric.md`.
