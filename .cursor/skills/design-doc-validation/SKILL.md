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

**CRITICAL CONSTRAINTS:**
1. Score **ONLY** the sections listed in the rubric tables below. Do NOT invent, add, or check sections that are not in these tables (e.g., do not check for "Integration Host Decisions", "Operator Checklist", "E2E Coverage Candidates", or any other section not explicitly listed).
2. Use **ONLY** the Apex platform enums defined below for persona, surface, and terminology checks. Apex is a product-building platform — it is NOT a timeclock, staffing, or healthcare application. Do not apply terms from other products.

### Canonical Apex Enums

**Persona names (Apex groups enum):** `Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`

**Target surface labels:** `Frontend only (React client)`, `Backend only (Express server)`, `Full-stack (both client and server)`, `Shared types only`, `Database migration only`

**Apex glossary terms:** `Interview`, `PRD`, `Design Doc`, `Design Prototype`, `PBI`, `TBI`, `Feature Flag`, `Skill`, `Backlog`, `Epic`, `Feature`, `RBAC`, `SSE`, `Facilitator`

**System Boundary ownership questions (Apex-specific):**
1. New or existing Express service in `src/server/services/`?
2. New or existing route in `src/server/routes/`?
3. New React component in `src/client/components/`?
4. New shared type in `src/shared/types/`?
5. Database migration needed?

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

### Design Doc Sections (weight sum = 100) — EXHAUSTIVE LIST

Score **only** these sections. The design doc should follow the template structure from `prd-design-spec/design-template.md`.

| Section | Weight | What to look for |
|---------|--------|-----------------|
| Feature Summary | 10 | Header with PRD slug, priority, feature flag, parent Epic, affected personas; 2–3 sentence business narrative; work-item index table |
| Scope and Out-of-Scope | 7 | In-scope behaviors and out-of-scope exclusions merged from Feature and PBI/TBI arrays |
| Acceptance Criteria | 25 | Consolidated Given/When/Then from backlog PBIs; all four scenarios (happy, error, edge, negative) per PBI |
| Target Surface | 8 | One of: `Frontend only (React client)`, `Backend only (Express server)`, `Full-stack (both client and server)`, `Shared types only`, `Database migration only`; plus experience notes |
| Access Control | 10 | Action/who/scope table; feature flag name, rollout, and behavior when disabled |
| UI/UX | 12 | Routes, component breakdown with states, validation, accessibility, data-testid; "Not applicable" for backend-only |
| Tech spec link | 5 | Relative link to `{feature-slug}-tech-spec.md` |
| Assumptions link | 5 | Link to `{feature-slug}-assumptions.md` with unresolved count |
| Apex terminology compliance | 12 | Uses Apex glossary terms correctly (see enum list above) |
| No residual template tokens | 6 | Zero `{token}`, `[TBD]`, or `TODO` patterns |

### Tech Spec Sections (weight sum = 100) — EXHAUSTIVE LIST

Score **only** these sections. The tech spec should follow the template structure from `prd-design-spec/tech-spec-template.md`.

| Section | Weight | What to look for |
|---------|--------|-----------------|
| System Boundary and Owning Layer | 10 | Owning layer named with rationale; answers the 5 Apex ownership questions (Express service? Route? React component? Shared type? DB migration?) — NOT other-product project names |
| Security Enforcement | 7 | Authorization mechanism citing existing RBAC pattern; scope enforcement layer; sensitive data handling |
| Architecture and Approach | 14 | Layers-touched table; per-PBI/TBI design decisions citing codebase patterns |
| Data and Contracts | 10 | API endpoints (method, route, request/response, auth); schema changes (table intent, no DDL) |
| Testing Strategy | 10 | Unit, integration, E2E guidance with module names and behaviors |
| Verification Test Matrix | 14 | VT-xx rows with Layer, Arrange, Act, Assert, linked PBI/TBI |
| Implementation Plan | 10 | Ordered checkable steps with VT-xx references and blocked-by notes |
| Mermaid Diagram 1 — Code Execution Flow | 4 | Valid `sequenceDiagram` with actors, participants, request/response chain, `alt` error block |
| Mermaid Diagram 2 — Implementation Dependency Map | 3 | Valid `flowchart TD` with step nodes, parallel subgraphs, test nodes, legend |
| Observability | 5 | Custom events/metrics or "None beyond standard telemetry"; alerts |
| Rollback and Deployment | 5 | Schema backward compatibility; rollback procedure; deployment dependencies; feature flag gate |
| No residual template tokens | 8 | Zero `{token}`, `[TBD]`, or `TODO` patterns |

### Assumptions Sections (weight sum = 100) — EXHAUSTIVE LIST

Score **only** these sections. The assumptions file should follow `prd-design-spec/assumptions-template.md`.

| Section | Weight | What to look for |
|---------|--------|-----------------|
| Header metadata | 10 | PRD slug, priority, feature flag (or None), relative links to both design doc and tech spec |
| Unresolved Items | 40 | Each `⚠` has label, question, impact, decision needed; or "None — all resolved" |
| Assumptions Accepted | 40 | Each assumption has label, what was assumed, derivation source, risk if wrong |
| Cross-file consistency | 10 | Every `⚠` in design/tech-spec has a matching entry in assumptions |

### Confidence score formula

```
per-file score = (Σ section_score × section_weight) / (3 × Σ section_weight) × 100
```

File weights: design **35%**, tech-spec **45%**, assumptions **20%**.

Overall score = weighted average of the three file scores.

### Cross-cutting checks

Run **only** these scans across all three files. Do not add additional checks beyond this list.

| Check | How |
|-------|-----|
| Template token scan | Count `\{[A-Za-z][^}]*\}` matches |
| `[TBD]` / `TODO` scan | Count matches |
| Terminology compliance | Flag non-canonical Apex terms — canonical list: `Interview`, `PRD`, `Design Doc`, `Design Prototype`, `PBI`, `TBI`, `Feature Flag`, `Skill`, `Backlog`, `Epic`, `Feature`, `RBAC`, `SSE`, `Facilitator`. Do NOT flag domain terms specific to the feature being designed (e.g. PDF, session, etc.) |
| `⚠` consolidation | Every `⚠` in design/tech-spec must have a matching entry in assumptions |
| Mermaid keyword presence | `sequenceDiagram` in diagram 1, `flowchart TD` in diagram 2 |
| AC scenario coverage | Every PBI has all 4 acceptance criteria scenarios (happy, error, edge, negative) |

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
