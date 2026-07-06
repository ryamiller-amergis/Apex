# Design Spec Review — Scorecard Templates (Apex)

---

## Phase 3 — Initial Scorecard

### Summary Table

```
## Design Spec Review — {slug}

| Feature | Design | Tech Spec | Assumptions | Overall | Verdict |
|---------|--------|-----------|-------------|---------|---------|
| {Feature title} | {n}% | {n}% | {n}% | {n}% | {Ready / Gaps / Significant gaps} |
| **OVERALL** | **{avg}%** | **{avg}%** | **{avg}%** | **{avg}%** | **{verdict}** |
```

**Verdict key:**
- `Ready` — overall >= 90%
- `Gaps` — overall 70–89%
- `Significant gaps` — overall < 70%

---

### Gap Detail Block (one per Feature)

```
### Feature: {Feature title}

#### Design doc gaps

| Section | Score | Missing / Shallow | What "3" looks like |
|---------|-------|-------------------|---------------------|
| {Section} | {0 or 1} | {description} | {from rubric.md} |

#### Tech spec gaps

| Section | Score | Missing / Shallow | What "3" looks like |
|---------|-------|-------------------|---------------------|
| {Section} | {0 or 1} | {description} | {from rubric.md} |

#### Assumptions gaps

| Section | Score | Missing / Shallow | What "3" looks like |
|---------|-------|-------------------|---------------------|
| {Section} | {0 or 1} | {description} | {from rubric.md} |
```

---

### Cross-Cutting Check Results

```
#### Cross-cutting checks

| Check | Status | Detail |
|-------|--------|--------|
| Template tokens | {Pass / Fail} | {detail} |
| [TBD] / TODO markers | {Pass / Fail} | {detail} |
| PBI/TBI coverage | {Pass / Fail} | {detail} |
| AC scenario coverage | {Pass / Fail} | {detail} |
| Terminology compliance | {Pass / Fail} | {detail} |
| Mermaid syntax | {Pass / Fail} | {detail} |
| ⚠ consolidation | {Pass / Fail} | {detail} |
| Missing files | {Pass / Fail} | {detail} |
```

---

## Phase 3b — Remediation AskQuestion Shape

```json
{
  "title": "Design spec review — remediation ({slug})",
  "questions": [
    {
      "id": "{feature-slug}-{file-type}-{section-slug}",
      "prompt": "[Feature: {title} | {file-type}: {section}] {gap}. How would you like to handle this gap?",
      "options": [
        { "id": "fill-now", "label": "Fill now — I will provide the content" },
        { "id": "defer", "label": "Defer — record as ⚠ in assumptions" },
        { "id": "accept", "label": "Accept as-is" }
      ]
    }
  ]
}
```

---

## Scorecard Files

### `review-scorecard.json`

```json
{
  "slug": "{slug}",
  "generated_at": "{ISO-8601}",
  "review_phase": "initial",
  "overall_score": 82,
  "ready_threshold": 90,
  "is_ready": false,
  "verdict": "gaps",
  "features": [
    {
      "feature_slug": "{feature-slug}",
      "feature_title": "{title}",
      "design_score": 87,
      "tech_spec_score": 72,
      "assumptions_score": 95,
      "overall_score": 81,
      "verdict": "gaps",
      "gaps": [
        {
          "id": "{feature-slug}-{file-type}-{section-slug}",
          "file": "tech-spec",
          "section": "{section}",
          "score": 1,
          "description": "{gap}",
          "what_3_looks_like": "{rubric text}",
          "resolution": "pending"
        }
      ]
    }
  ],
  "cross_cutting_checks": {
    "template_tokens": "pass",
    "tbd_markers": "pass",
    "pbi_tbi_coverage": "pass",
    "ac_scenario_coverage": "pass",
    "terminology_compliance": "pass",
    "mermaid_syntax": "pass",
    "unresolved_consolidation": "pass",
    "missing_files": "pass"
  },
  "accepted_gaps": [],
  "deferred_gaps": []
}
```

### `review-scorecard.md`

Verbatim copy of the chat scorecard output.

---

## Phase 4 — Final Scorecard

```
## Design Spec Review — Final Scorecard ({slug})

| Feature | Design | Tech Spec | Assumptions | Overall | Change | Verdict |
|---------|--------|-----------|-------------|---------|--------|---------|
| {title} | {before}% → {after}% | {before}% → {after}% | {before}% → {after}% | {before}% → {after}% | {+n pts} | {verdict} |
| **OVERALL** | **→** | | | **{before}% → {after}%** | **{+n pts}** | **{verdict}** |
```

### Next steps

**>= 90% — Ready**
```
All Features scored >= 90%. Ready for /kick-off implementation planning.
```

**70–89% — Gaps remain**
```
{n} Feature(s) remain below 90%. Run /design-spec-review {slug} again after edits.
```

**< 70% — Significant gaps**
```
Consider re-running /prd-design-spec {slug} with additional context.
```
