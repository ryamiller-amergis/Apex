---
name: design-doc-validation
description: APEX adapter for design-doc-validation. Loads the generic scoring-engine foundation and supplies APEX's section rubric tables, canonical enums, file weights, and documentValidationService integration.
---

# design-doc-validation — APEX Adapter

<!-- Managed loader: loads .apex/foundation/design-doc-validation/SKILL.md -->
Binds the generic scoring engine to APEX. Runs automatically — the
`documentValidationService` launches it as an AI agent thread when a design doc
transitions to `validating`. No user interaction.

- Project: {{slot:projectName}}
- Output: `.ai-pilot/output/review-scorecard.json` and `review-scorecard.md`
- Consumer interface: `ValidationScorecard` (parsed by `documentValidationService`) — match exactly.

## Input context

Injected by `designDocService.autoStartValidation`: `doc_id`, Source PRD, Design,
Tech Spec, Assumptions. If Design, Tech Spec, and Assumptions are all empty,
write a scorecard with `overall_score: 0`, `is_ready: false`,
`verdict: "significant_gaps"` and stop.

## Canonical APEX enums (use ONLY these)

- Persona names: `Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`
- Target surfaces: `Frontend only (React client)`, `Backend only (Express server)`, `Full-stack (both client and server)`, `Shared types only`, `Database migration only`
- Glossary terms: `Interview`, `PRD`, `Design Doc`, `Design Prototype`, `PBI`, `TBI`, `Feature Flag`, `Skill`, `Backlog`, `Epic`, `Feature`, `RBAC`, `SSE`, `Facilitator`
- System Boundary ownership questions: Express service in `src/server/services/`? Route in `src/server/routes/`? React component in `src/client/components/`? Shared type in `src/shared/types/`? DB migration needed?

APEX is a product-building platform — NOT a timeclock, staffing, or healthcare
application. Do not apply terms from other products.

## Section rubrics and file weights

Score only the sections defined in `rubric.md` (design, tech spec, assumptions
tables). File weights: design 35%, tech-spec 45%, assumptions 20%. Run only the
cross-cutting checks listed in `rubric.md`.
