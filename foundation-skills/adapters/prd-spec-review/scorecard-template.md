# PRD Spec Review - Scorecard Templates

---

## Phase 3 - Initial Scorecard

Print this after Phase 2 scoring is complete.

### Summary Table

```
## PRD Spec Review - {slug}

| File | Score | Verdict |
|------|-------|---------|
| PRD markdown (`{slug}.prd.md`) | {n}% | {Ready / Gaps / Significant gaps} |
| Backlog JSON (`{slug}.backlog.json`) | {n}% | {Ready / Gaps / Significant gaps} |
| **OVERALL** | **{avg}%** | **{verdict}** |
```

**Verdict key:**
- `Ready` - overall >= 90%
- `Gaps` - overall 70-89%
- `Significant gaps` - overall < 70%

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

| ID | Check | Status | Detail |
|----|-------|--------|--------|
| `template_tokens` | Template token scan | {Pass / Fail} | {Count and locations, or "None found"} |
| `tbd_markers` | [TBD] / TODO / FIXME scan | {Pass / Fail} | {Count and locations, or "None found"} |
| `persona_vocabulary_compliance` | Persona vocabulary compliance | {Pass / Fail} | {Non-compliant personas, or "All personas resolve to project vocabulary"} |
| `feature_pbi_persona_alignment` | Feature <-> PBI persona alignment | {Pass / Fail} | {Detail} |
| `user_story_pbi_traceability` | User story <-> PBI traceability | {Pass / Fail} | {Detail} |
| `scope_traceability` | PRD scope traceability | {Pass / Fail} | {Detail} |
| `out_of_scope_alignment` | Out-of-scope alignment | {Pass / Fail} | {Detail} |
| `target_surface_alignment` | Target surface alignment | {Pass / Fail} | {Detail} |
| `nfr_consistency` | Non-functional requirements consistency | {Pass / Fail} | {Detail} |
| `business_rule_traceability` | Business rule traceability | {Pass / Fail} | {Detail} |
| `ac_scenario_coverage` | Acceptance-criteria scenario coverage | {Pass / Fail} | {Detail} |
| `depends_on_dag_validity` | dependsOn DAG validity | {Pass / Fail} | {Detail} |
| `dependency_locality` | Dependency locality | {Pass / Fail} | {Detail} |
| `implementation_phase_coverage` | Implementation-phase coverage | {Pass / Fail} | {Detail} |
| `feature_flag_alignment` | Feature-flag alignment | {Pass / Fail} | {Detail} |
| `terminology_consistency` | Project terminology consistency | {Pass / Fail} | {Detail} |
```

---

## Phase 3b - Remediation AskQuestion Shape

```json
{
  "title": "PRD spec review - remediation ({slug})",
  "questions": [
    {
      "id": "{file-type}-{section-slug}",
      "prompt": "[File: {file-type} | Section: {section-name}] {gap description}. How would you like to handle this gap?",
      "options": [
        { "id": "fill-now", "label": "Fill now - I will provide the missing content" },
        { "id": "defer", "label": "Defer - record as warning in PRD Assumptions Made" },
        { "id": "accept", "label": "Accept as-is - acknowledge the gap" }
      ]
    }
  ]
}
```

---

## Scorecard Files - Written to Disk

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
    "template_tokens": {
      "label": "Template token scan",
      "status": "pass",
      "detail": "None found"
    },
    "tbd_markers": {
      "label": "[TBD] / TODO / FIXME scan",
      "status": "pass",
      "detail": "None found"
    },
    "persona_vocabulary_compliance": {
      "label": "Persona vocabulary compliance",
      "status": "pass",
      "detail": "All personas resolve to project vocabulary"
    },
    "feature_pbi_persona_alignment": {
      "label": "Feature <-> PBI persona alignment",
      "status": "pass",
      "detail": "All PBI personas align with their parent Feature"
    },
    "user_story_pbi_traceability": {
      "label": "User story <-> PBI traceability",
      "status": "pass",
      "detail": "Every user story is grounded in a PBI"
    },
    "scope_traceability": {
      "label": "PRD scope traceability",
      "status": "pass",
      "detail": "Every backlog item is grounded in the PRD narrative"
    },
    "out_of_scope_alignment": {
      "label": "Out-of-scope alignment",
      "status": "pass",
      "detail": "No contradictions between exclusions and backlog scope"
    },
    "target_surface_alignment": {
      "label": "Target surface alignment",
      "status": "pass",
      "detail": "Target surfaces match backlog behavior"
    },
    "nfr_consistency": {
      "label": "Non-functional requirements consistency",
      "status": "pass",
      "detail": "NFRs align with backlog delivery expectations"
    },
    "business_rule_traceability": {
      "label": "Business rule traceability",
      "status": "pass",
      "detail": "Every business rule reference is grounded and enforced"
    },
    "ac_scenario_coverage": {
      "label": "Acceptance-criteria scenario coverage",
      "status": "pass",
      "detail": "Every PBI covers the required scenarios"
    },
    "depends_on_dag_validity": {
      "label": "dependsOn DAG validity",
      "status": "pass",
      "detail": "No cycles, self-edges, or dangling references"
    },
    "dependency_locality": {
      "label": "Dependency locality",
      "status": "pass",
      "detail": "All item-level dependencies stay within their owning Feature"
    },
    "implementation_phase_coverage": {
      "label": "Implementation-phase coverage",
      "status": "pass",
      "detail": "Every Epic is assigned to a valid implementation phase"
    },
    "feature_flag_alignment": {
      "label": "Feature-flag alignment",
      "status": "pass",
      "detail": "Feature-flag intent is consistent across PRD and backlog"
    },
    "terminology_consistency": {
      "label": "Project terminology consistency",
      "status": "pass",
      "detail": "Project glossary terms are used consistently"
    }
  },
  "accepted_gaps": [],
  "deferred_gaps": []
}
```

### `{slug}-prd-review-scorecard.md`

Verbatim copy of the chat scorecard output.

---

## Phase 4 - Final Scorecard

```
## PRD Spec Review - Final Scorecard ({slug})

| File | Before | After | Change | Verdict |
|------|--------|-------|--------|---------|
| PRD markdown | {before}% | {after}% | {+n pts} | {verdict} |
| Backlog JSON | {before}% | {after}% | {+n pts} | {verdict} |
| **OVERALL** | **{before}%** | **{after}%** | **{+n pts}** | **{verdict}** |
```

### Next steps

**>= 90% - Ready**
```
Scored >= 90% overall. Artifacts are ready for the team's next downstream step.
```

**70-89% - Gaps remain**
```
{n} section(s) remain below 90%. Address the gaps and re-run the review after edits.
```

**< 70% - Significant gaps**
```
Consider revisiting the upstream requirements or backlog authoring inputs before re-reviewing.
```
