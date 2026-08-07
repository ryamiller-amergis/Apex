# Design Spec Review - Scorecard Templates

---

## Phase 3 - Initial Scorecard

### Summary Table

```
## Design Spec Review - {slug}

| Feature | Design | Tech Spec | Assumptions | Overall | Verdict |
|---------|--------|-----------|-------------|---------|---------|
| {Feature title} | {n}% | {n}% | {n}% | {n}% | {Ready / Gaps / Significant gaps} |
| **OVERALL** | **{avg}%** | **{avg}%** | **{avg}%** | **{avg}%** | **{verdict}** |
```

**Verdict key:**
- `Ready` - overall >= 90%
- `Gaps` - overall 70-89%
- `Significant gaps` - overall < 70%

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

| ID | Check | Status | Detail |
|----|-------|--------|--------|
| `template_tokens` | Template token scan | {Pass / Fail} | {Detail} |
| `tbd_markers` | [TBD] / TODO scan | {Pass / Fail} | {Detail} |
| `work_item_coverage` | Work-item coverage | {Pass / Fail} | {Detail} |
| `ac_scenario_coverage` | Acceptance-criteria scenario coverage | {Pass / Fail} | {Detail} |
| `terminology_consistency` | Project terminology consistency | {Pass / Fail} | {Detail} |
| `mermaid_keyword_presence` | Mermaid keyword presence | {Pass / Fail} | {Detail} |
| `warning_consolidation` | Warning consolidation | {Pass / Fail} | {Detail} |
| `missing_files` | Missing files | {Pass / Fail} | {Detail} |
```

---

## Phase 3b - Remediation AskQuestion Shape

```json
{
  "title": "Design spec review - remediation ({slug})",
  "questions": [
    {
      "id": "{feature-slug}-{file-type}-{section-slug}",
      "prompt": "[Feature: {title} | {file-type}: {section}] {gap}. How would you like to handle this gap?",
      "options": [
        { "id": "fill-now", "label": "Fill now - I will provide the content" },
        { "id": "defer", "label": "Defer - record as warning in assumptions" },
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
    "template_tokens": {
      "label": "Template token scan",
      "status": "pass",
      "detail": "None found"
    },
    "tbd_markers": {
      "label": "[TBD] / TODO scan",
      "status": "pass",
      "detail": "None found"
    },
    "work_item_coverage": {
      "label": "Work-item coverage",
      "status": "pass",
      "detail": "Every referenced backlog item is represented across the three artifacts"
    },
    "ac_scenario_coverage": {
      "label": "Acceptance-criteria scenario coverage",
      "status": "pass",
      "detail": "Every covered backlog item includes the required scenarios"
    },
    "terminology_consistency": {
      "label": "Project terminology consistency",
      "status": "pass",
      "detail": "Project glossary terms are used consistently"
    },
    "mermaid_keyword_presence": {
      "label": "Mermaid keyword presence",
      "status": "pass",
      "detail": "Required Mermaid diagram keywords are present"
    },
    "warning_consolidation": {
      "label": "Warning consolidation",
      "status": "pass",
      "detail": "Warnings in design and tech spec are mirrored in assumptions"
    },
    "missing_files": {
      "label": "Missing files",
      "status": "pass",
      "detail": "All required artifacts are present"
    }
  },
  "accepted_gaps": [],
  "deferred_gaps": []
}
```

### `review-scorecard.md`

Verbatim copy of the chat scorecard output.

---

## Phase 4 - Final Scorecard

```
## Design Spec Review - Final Scorecard ({slug})

| Feature | Design | Tech Spec | Assumptions | Overall | Change | Verdict |
|---------|--------|-----------|-------------|---------|--------|---------|
| {title} | {before}% -> {after}% | {before}% -> {after}% | {before}% -> {after}% | {before}% -> {after}% | {+n pts} | {verdict} |
| **OVERALL** | **->** | | | **{before}% -> {after}%** | **{+n pts}** | **{verdict}** |
```

### Next steps

**>= 90% - Ready**
```
All Features scored >= 90%. Artifacts are ready for the team's next downstream step.
```

**70-89% - Gaps remain**
```
{n} Feature(s) remain below 90%. Address the gaps and re-run the review after edits.
```

**< 70% - Significant gaps**
```
Consider revisiting the upstream design inputs before re-reviewing.
```
