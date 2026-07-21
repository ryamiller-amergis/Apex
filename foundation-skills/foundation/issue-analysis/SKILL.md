---
name: issue-analysis
description: Project-agnostic method for evaluating a reported issue and producing a structured priority/risk analysis as JSON. Project framing and file locations come from the adapter.
---

# Issue Analysis — Foundation (project-agnostic)

Evaluate a reported issue from the supplied context and produce a structured
priority/risk analysis. The adapter supplies the product framing and the exact
input/output locations.

## Assess

- Affected workflow and likely breadth of user or system impact.
- Evidence about frequency, reproducibility, regression risk, and available workarounds.
- Potential for data loss, security exposure, service degradation, or blocked delivery.
- Likely diagnostic and remediation complexity, dependencies, and safe rollback options.

## Priority

Assign `priority` as `low`, `medium`, `high`, or `critical`. Reserve `critical`
for active security exposure, data loss, widespread outage, or a core workflow
blocker without a workaround.

## Risk

Assign `risk` as `low`, `medium`, or `high`, reflecting uncertainty, blast
radius, remediation complexity, sensitive-data or auth impact, and regression
potential.

## Output

Write exactly this JSON shape (valid JSON, no comments or trailing commas):

```json
{
  "priority": "low | medium | high | critical",
  "risk": "low | medium | high",
  "rationale": "A single 2-4 sentence explanation"
}
```

Do not ask questions; analyze the supplied context and write the result autonomously.
