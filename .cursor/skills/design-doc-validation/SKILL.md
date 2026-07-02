---
name: design-doc-validation
description: >-
  Automated quality gate that scores a generated design doc (design, tech spec,
  assumptions) against the weighted rubric and outputs a ValidationScorecard
  JSON + human-readable report. Runs unattended via the documentValidationService
  when a design doc transitions to 'validating' status. The scorecard determines
  whether the doc moves to 'pending_review' (score >= 90) or stays in 'draft'.
  Do not invoke this skill manually — use /design-spec-review for interactive reviews.
---

# design-doc-validation

Receives design doc content (design markdown, tech spec markdown, assumptions markdown, and optionally the source PRD) as freeform context. Scores every required section against a deterministic rubric, computes confidence scores, and writes a `ValidationScorecard` JSON + markdown report to `.ai-pilot/output/`.

**This skill runs automatically** — the `documentValidationService` launches it as an AI agent thread when a design doc is created or regenerated. No user interaction is expected or supported.

## Input

The freeform context (injected by `designDocService.autoStartValidation`) contains:

```
# Design Doc Validation Context
doc_id: {uuid}

## Source PRD
{prd content or "(empty)"}

## Design
{design markdown content}

## Tech Spec
{tech spec markdown content}

## Assumptions
{assumptions markdown content}
```

---

## Persona — Automated Quality Gate

You are a deterministic scoring engine. Do not ask questions, request clarification, or produce conversational output. Your only job is to score the content and write the scorecard files.

---

## Phase 1 — Parse Input

1. Extract the `doc_id` from the context header.
2. Extract the four content sections: Source PRD, Design, Tech Spec, Assumptions.
3. If Design, Tech Spec, and Assumptions are all `(empty)`, write a scorecard with `overall_score: 0`, `is_ready: false`, `verdict: "significant_gaps"` and stop.

---

## Phase 2 — Score

Apply the scoring rubric below to each section. Every score is on a 0–3 scale.

### Score Scale

| Score | Label | Meaning |
|-------|-------|---------|
| 0 | Missing | Section absent, or body is still a template placeholder (`{...}`) or `[TBD]` |
| 1 | Shallow | Section header present with minimal or generic content |
| 2 | Substantive | Addresses intent with specific, named modules/routes/layers; grounded in codebase |
| 3 | Complete | Actionable, cross-referenced, and traceable; an implementer could work from this alone |

### Design Doc Sections (weight sum = 100)

| Section | Weight |
|---------|--------|
| Feature Summary | 10 |
| Scope and Out-of-Scope | 7 |
| Acceptance Criteria | 25 |
| Target Surface | 8 |
| Access Control | 10 |
| UI/UX | 12 |
| Tech spec link | 5 |
| Assumptions link | 5 |
| Apex terminology compliance | 12 |
| No residual template tokens | 6 |

### Tech Spec Sections (weight sum = 100)

| Section | Weight |
|---------|--------|
| System Boundary and Owning Layer | 10 |
| Security Enforcement | 7 |
| Architecture and Approach | 14 |
| Data and Contracts | 10 |
| Testing Strategy | 10 |
| Verification Test Matrix | 14 |
| Implementation Plan | 10 |
| Mermaid Diagram 1 — Code Execution Flow | 4 |
| Mermaid Diagram 2 — Implementation Dependency Map | 3 |
| Observability | 5 |
| Rollback and Deployment | 5 |
| No residual template tokens | 8 |

### Assumptions Sections (weight sum = 100)

| Section | Weight |
|---------|--------|
| Header metadata | 10 |
| Unresolved Items | 40 |
| Assumptions Accepted | 40 |
| Cross-file consistency | 10 |

### Confidence score formula

```
per-file score = (Σ section_score × section_weight) / (3 × Σ section_weight) × 100
```

File weights: design **35%**, tech-spec **45%**, assumptions **20%**.

Overall score = weighted average of the three file scores.

### Cross-cutting checks

Run these scans across all three files:

| Check | How |
|-------|-----|
| Template token scan | Count `\{[A-Za-z][^}]*\}` matches |
| `[TBD]` / `TODO` scan | Count matches |
| Terminology compliance | Flag non-canonical Apex terms (Interview, PRD, Design Doc, Design Prototype, PBI, TBI, Feature Flag, Skill, Backlog, Epic, Feature) |
| `⚠` consolidation | Every `⚠` in design/tech-spec must have a matching entry in assumptions |
| Mermaid keyword presence | `sequenceDiagram` in diagram 1, `flowchart TD` in diagram 2 |

### Verdict

| Overall Score | Verdict |
|---------------|---------|
| >= 90 | `ready` |
| 70–89 | `gaps` |
| < 70 | `significant_gaps` |

`is_ready = true` only when verdict is `ready`.

---

## Phase 3 — Write Output

Write **exactly two files** to `.ai-pilot/output/`:

### 1. `review-scorecard.json`

Must conform to the `ValidationScorecard` interface:

```json
{
  "slug": "{derived-from-doc-id}",
  "generated_at": "{ISO-8601}",
  "review_phase": "initial",
  "overall_score": 85.3,
  "ready_threshold": 90,
  "is_ready": false,
  "verdict": "gaps",
  "features": [
    {
      "feature_slug": "{slug}",
      "feature_title": "{title}",
      "design_score": 88.5,
      "tech_spec_score": 82.1,
      "assumptions_score": 91.0,
      "overall_score": 85.3,
      "verdict": "gaps",
      "gaps": [
        {
          "id": "gap-001",
          "file": "design",
          "section": "Acceptance Criteria",
          "score": 1,
          "description": "PBI-002 missing error and edge scenarios",
          "what_3_looks_like": "All 4 scenario rows (happy, error, edge, negative) with concrete Then clauses",
          "resolution": "pending"
        }
      ]
    }
  ],
  "cross_cutting_checks": {
    "template_tokens": "0 found",
    "tbd_todo": "2 found",
    "terminology": "All canonical",
    "warning_consolidation": "1 unmatched ⚠"
  },
  "accepted_gaps": [],
  "deferred_gaps": []
}
```

### 2. `review-scorecard.md`

Human-readable validation report:

```markdown
# Validation Report

| Metric | Value |
|--------|-------|
| Overall Score | **85.3%** |
| Verdict | gaps |
| Phase | initial |
| Ready | No |

## Feature Scores

| Feature | Design | Tech Spec | Assumptions | Overall | Verdict |
|---------|--------|-----------|-------------|---------|---------|
| {title} | 88.5% | 82.1% | 91.0% | 85.3% | gaps |

## Open Gaps

- **Acceptance Criteria** (design): PBI-002 missing error and edge scenarios — Score: 1/3

## Cross-Cutting Checks

- **template_tokens**: 0 found
- **tbd_todo**: 2 found
- **terminology**: All canonical
- **warning_consolidation**: 1 unmatched ⚠
```

---

## Non-Negotiable Rules

1. **No user interaction.** Do not ask questions or wait for input.
2. **Deterministic scoring.** Every score must be justified by the rubric criteria above.
3. **Always write both files.** Even for a score of 0, write the scorecard.
4. **Do not modify the design doc content.** This skill is read-only on the source material.
5. **Do not write production code.** Only scorecard output files.
6. **Ensure `.ai-pilot/output/` exists** before writing.
7. **Match the `ValidationScorecard` interface exactly.** The `documentValidationService` parses `review-scorecard.json` by schema — any deviation causes a validation error reset.
