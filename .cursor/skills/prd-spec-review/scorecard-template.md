# PRD Spec Review — Scorecard Templates (Apex)

---

## Phase 3 — Initial Scorecard

Print this after Phase 2 scoring is complete.

### Summary Table

```
## PRD Spec Review — {slug}

| File | Score | Verdict |
|------|-------|---------|
| PRD markdown (`{slug}.prd.md`) | {n}% | {Ready / Gaps / Significant gaps} |
| Backlog JSON (`{slug}.backlog.json`) | {n}% | {Ready / Gaps / Significant gaps} |
| **OVERALL** | **{avg}%** | **{verdict}** |
```

**Verdict key:**
- `Ready` — overall >= 90%
- `Gaps` — overall 70–89%
- `Significant gaps` — overall < 70%

---

### Gap Detail Block (one block per file with gaps)

```
### File: PRD markdown

| Section | Score | Missing / Shallow | What "3" looks like |
|---------|-------|-------------------|---------------------|
| {Section name} | {0 or 1} | {description} | {from rubric.md} |

### File: Backlog JSON

| Section | Score | Missing / Shallow | What "3" looks like |
|---------|-------|-------------------|---------------------|
| {Section name} | {0 or 1} | {description} | {from rubric.md} |
```

Omit a file's gap table if that file has no sections scoring 0 or 1.

---

### Cross-Cutting Check Results

```
#### Cross-cutting checks

| Check | Status | Detail |
|-------|--------|--------|
| Template tokens | {Pass / Fail} | {Count and locations, or "None found"} |
| [TBD] / TODO markers | {Pass / Fail} | {Count and locations, or "None found"} |
| Persona enum compliance | {Pass / Fail} | {Non-compliant names, or "All personas valid"} |
| User story ↔ PBI traceability | {Pass / Fail} | {detail} |
| PRD scope traceability | {Pass / Fail} | {detail} |
| Out of scope alignment | {Pass / Fail} | {detail} |
| Target surface alignment | {Pass / Fail} | {detail} |
| NFR consistency | {Pass / Fail} | {detail} |
| Business rule traceability | {Pass / Fail} | {detail} |
| AC scenario coverage | {Pass / Fail} | {detail} |
| dependsOn DAG validity | {Pass / Fail} | {detail} |
| Feature flag alignment | {Pass / Fail} | {detail} |
| Terminology compliance | {Pass / Fail} | {detail} |
```

---

## Phase 3b — Remediation AskQuestion Shape

```json
{
  "title": "PRD spec review — remediation ({slug})",
  "questions": [
    {
      "id": "{file-type}-{section-slug}",
      "prompt": "[File: {file-type} | Section: {section-name}] {gap description}. How would you like to handle this gap?",
      "options": [
        { "id": "fill-now", "label": "Fill now — I will provide the missing content" },
        { "id": "defer", "label": "Defer — record as ⚠ in PRD Assumptions Made" },
        { "id": "accept", "label": "Accept as-is — acknowledge the gap" }
      ]
    }
  ]
}
```

---

## Scorecard Files — Written to Disk

### `{slug}-prd-review-scorecard.json`

```json
{
  "slug": "{slug}",
  "generated_at": "{ISO-8601}",
  "review_phase": "initial",
  "overall_score": 78,
  "ready_threshold": 90,
  "is_ready": false,
  "verdict": "gaps",
  "files": [
    {
      "file": "prd",
      "filename": "{slug}.prd.md",
      "score": 82,
      "verdict": "gaps",
      "gaps": [
        {
          "id": "prd-{section-slug}",
          "section": "{section name}",
          "score": 1,
          "description": "{gap}",
          "what_3_looks_like": "{rubric text}",
          "resolution": "pending"
        }
      ]
    },
    {
      "file": "backlog",
      "filename": "{slug}.backlog.json",
      "score": 74,
      "verdict": "gaps",
      "gaps": []
    }
  ],
  "cross_cutting_checks": {
    "template_tokens": "pass",
    "tbd_markers": "pass",
    "persona_enum_compliance": "pass",
    "ac_scenario_coverage": "pass",
    "depends_on_dag_validity": "pass",
    "feature_flag_alignment": "pass",
    "terminology_compliance": "pass"
  },
  "accepted_gaps": [],
  "deferred_gaps": []
}
```

### `{slug}-prd-review-scorecard.md`

Verbatim copy of the chat scorecard output.

---

## Phase 4 — Final Scorecard

```
## PRD Spec Review — Final Scorecard ({slug})

| File | Before | After | Change | Verdict |
|------|--------|-------|--------|---------|
| PRD markdown | {before}% | {after}% | {+n pts} | {verdict} |
| Backlog JSON | {before}% | {after}% | {+n pts} | {verdict} |
| **OVERALL** | **{before}%** | **{after}%** | **{+n pts}** | **{verdict}** |
```

### Next steps

**>= 90% — Ready**
```
Scored >= 90% overall. Run one of:
  /prd-design-spec {slug}   — generate per-Feature design artifacts
  /kick-off                 — start implementation planning
```

**70–89% — Gaps remain**
```
{n} section(s) remain below 90%. Run /prd-spec-review {slug} again after edits.
```

**< 70% — Significant gaps**
```
Consider re-running /to-prd with a revised .ai-pilot/kickoff-transcript.md.
```
