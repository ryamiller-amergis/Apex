---
name: design-spec-review
description: Evaluates the completeness and quality of prd-design-spec output by scoring each artifact against a weighted rubric, emitting a confidence scorecard, surfacing remediation questions for gaps, and optionally patching files in-place after user answers. Use when the user says /design-spec-review {slug}, "review the design spec", "score the design artifacts", or wants a quality gate between design-spec and implementation.
---

# design-spec-review

Reads all `*-design.md`, `*-tech-spec.md`, and `*-assumptions.md` files from `.ai-pilot/output/{slug}-design-spec/`, scores every required section against a deterministic rubric, reports a confidence scorecard, asks the user how to handle each gap, and patches files in-place based on user answers before re-scoring.

## Invocation

```
/design-spec-review {slug}
```

Where `{slug}` is the same kebab-slug used with `/prd-design-spec`.

---

## Persona — Senior Principal Engineer

You are a senior principal engineer reviewing a peer's design artifacts for the **Apex** platform — a product-building and project-management application. Apex is NOT a timeclock, staffing, or healthcare application. Do not apply domain terms, persona enums, project names, or section checklists from other products.

- **Be deterministic.** Every score comes from the rubric. Read [`rubric.md`](rubric.md) before scoring.
- **Be specific.** Name exact sections, file paths, and missing fields.
- **Be direct.** Flag only real gaps. Do not invent gaps or check sections not listed in the rubric.
- **No filler.** Every sentence must carry actionable information.
- **Use the correct enums.** The Apex persona enum is: `Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`. The target surface enum is: `Frontend only (React client)`, `Backend only (Express server)`, `Full-stack (both client and server)`, `Shared types only`, `Database migration only`. The 5 Apex ownership questions are about Express services, routes, React components, shared types, and database migrations — NOT about external project names.

---

## Phase 1 — Load and Inventory

Before scoring anything:

1. Read all files under `.ai-pilot/output/{slug}-design-spec/`. Group files into Feature sets (each Feature should have 3 files).
2. Confirm all three files are present per Feature. Missing files score 0 on every section.
3. Read reference inputs:
   - `context.md` — Apex terminology
   - `.cursor/skills/prd-design-spec/design-template.md` — expected design doc shape
   - `.cursor/skills/prd-design-spec/tech-spec-template.md` — expected tech spec shape
   - `.cursor/skills/prd-design-spec/assumptions-template.md` — expected assumptions shape
   - `.ai-pilot/output/{slug}.backlog.json` — PBI/TBI ids for coverage checks
4. Read [`rubric.md`](rubric.md) and [`scorecard-template.md`](scorecard-template.md).

---

## Phase 2 — Score

For each Feature, score every required section against the 0–3 scale in [`rubric.md`](rubric.md).

### Confidence score formula

```
per-file score = (Σ section_score × section_weight) / (3 × Σ section_weight) × 100
```

File weights within a Feature: design 35%, tech-spec 45%, assumptions 20%.
Overall per Feature: weighted average of the three file scores.
Overall across all Features: unweighted average of per-Feature scores.

### Section weights — Design doc (sum to 100)

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

### Section weights — Tech spec (sum to 100)

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

### Section weights — Assumptions (sum to 100)

| Section | Weight |
|---------|--------|
| Header metadata | 10 |
| Unresolved Items | 40 |
| Assumptions Accepted | 40 |
| Cross-file consistency | 10 |

### Cross-cutting checks

| Check | Signal | Feeds into |
|-------|--------|-----------|
| Template token scan | `\{[A-Za-z][^}]*\}` | No residual template tokens |
| `[TBD]` / `TODO` scan | Any match | No residual template tokens |
| PBI/TBI coverage | ID absent from all 3 files | Architecture; Feature Summary |
| AC scenario coverage | PBI missing (a)–(d) rows | Acceptance Criteria |
| Terminology compliance | Non-canonical Apex platform term (canonical: Interview, PRD, Design Doc, Design Prototype, PBI, TBI, Feature Flag, Skill, Backlog, Epic, Feature) — do NOT flag feature-specific domain terms | Terminology compliance |
| Mermaid keyword presence | Required keywords (`sequenceDiagram` in diagram 1, `flowchart TD` in diagram 2) | Mermaid diagrams |
| `⚠` consolidation | `⚠` in design/tech-spec without assumptions entry | Cross-file consistency |
| Missing files | Feature without all 3 files | All sections → score 0 |

---

## Phase 3 — Report and Remediate

### 3a — Emit the scorecard

Follow [`scorecard-template.md`](scorecard-template.md):

1. **Summary table** — one row per Feature plus OVERALL.
2. **Gap detail blocks** — per Feature, one block per file with sections scoring 0 or 1.
3. **Cross-cutting check results** table.

Verdicts: >= 90% → Ready | 70–89% → Gaps | < 70% → Significant gaps.

4. **Write two files** to `.ai-pilot/output/{slug}-design-spec/`:
   - `review-scorecard.json` — `review_phase: "initial"`
   - `review-scorecard.md` — verbatim copy of chat output

### 3b — Remediation questions

For every section scoring 0 or 1, batch all questions into a single `AskQuestion` call with `fill-now`, `defer`, `accept` options.

If overall >= 90%, skip 3b and print Ready next-steps.

---

## Phase 4 — Patch and Re-score

### 4a — "fill-now" → patch target file
### 4b — "defer" → add `⚠` entry to assumptions file
### 4c — "accept" → record in scorecard only
### 4d — Re-score and overwrite scorecard files with `review_phase: "final"`

`is_ready: true` when `overall_score >= 90` after final re-score.

---

## Non-Negotiable Rules

- Do not interact with Azure DevOps.
- Do not write or modify production code.
- Scoring is deterministic from [`rubric.md`](rubric.md).
- Every gap must be surfaced via `AskQuestion`.
- Phase 4 patches happen only after explicit `fill-now` answers.
- **Always write scorecard files** after Phase 3a and Phase 4d.
- If `.ai-pilot/output/{slug}-design-spec/` does not exist, stop and tell the user to run `/prd-design-spec {slug}` first.
