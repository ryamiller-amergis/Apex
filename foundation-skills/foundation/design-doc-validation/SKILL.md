---
name: design-doc-validation
description: Automated quality gate that scores a generated design document (design, tech spec, assumptions) against a weighted rubric and outputs a ValidationScorecard. Use when validating a design doc before sending for review.
---

# Design Doc Validation — Foundation

Automated quality gate for design documents. Scores the design doc against a weighted rubric.

## Inputs

Read the three design artifact files for the feature:
- `{slug}-design.md` — the design document
- `{slug}-tech-spec.md` — the technical specification  
- `{slug}-assumptions.md` — the shared assumptions

## Scoring rubric

| Section | Weight | Pass criteria |
|---------|--------|---------------|
| Problem statement | 15% | Clear problem, scope, user impact |
| Solution | 20% | Concrete approach, not just intent |
| Technical decisions | 25% | Implementation choices with rationale |
| Security & access | 15% | Auth, permissions, data sensitivity addressed |
| Testing strategy | 15% | Test coverage plan for each layer |
| Assumptions | 10% | Explicit, testable, documented |

**Scoring scale:** 0–2 per section (0 = missing/inadequate, 1 = partial, 2 = complete)

**Pass threshold:** Total weighted score >= 90% (configurable per project via adapter)

## Output

Produce a `ValidationScorecard`:
```json
{
  "slug": "feature-slug",
  "totalScore": 85,
  "passed": false,
  "sections": [
    { "name": "Problem statement", "score": 2, "notes": "..." },
    ...
  ],
  "recommendation": "pending_review | draft"
}
```

## Scoring behavior

- Score >= 90: recommend `pending_review`
- Score < 90: recommend `draft` with specific improvement notes per section
- Do not modify the design doc files — only report findings
