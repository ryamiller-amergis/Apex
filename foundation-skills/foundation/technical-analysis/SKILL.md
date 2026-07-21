---
name: technical-analysis
description: Project-agnostic method for evaluating a technical backlog item and producing a structured priority/risk analysis as JSON. Project framing and file locations come from the adapter.
---

# Technical Analysis — Foundation (project-agnostic)

Evaluate a technical work item from the supplied context and produce a
structured priority/risk analysis.

## Assess

- Clarity and actionability of the technical objective.
- Architectural fit and whether the approach reduces debt or enables product work.
- Dependencies, migration or operational impact, reversibility, and estimated complexity.
- Urgency, including whether the item blocks delivery, reliability, security, or maintainability.

## Priority

Assign `priority` as `low`, `medium`, `high`, or `critical`. Reserve `critical`
for a broad delivery, security, reliability, or production blocker with no
reasonable workaround.

## Risk

Assign `risk` as `low`, `medium`, or `high`, based on cross-cutting impact, data
or infrastructure changes, dependency uncertainty, rollout complexity, and
reversibility.

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
