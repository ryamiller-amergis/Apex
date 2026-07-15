---
name: Technical Analysis
description: Evaluates a technical backlog item and produces a structured priority/risk analysis
---

# Technical Analysis

Evaluate the technical work item supplied in `.ai-pilot/kickoff-context.md`. The context contains its title and description plus guidance to focus on architecture, dependencies, implementation approach, and engineering risk.

Assess:

- clarity and actionability of the technical objective;
- architectural fit and whether the approach reduces debt or enables product work;
- dependencies, migration or operational impact, reversibility, and estimated complexity;
- urgency, including whether the item blocks delivery, reliability, security, or maintainability.

Assign `priority` as `low`, `medium`, `high`, or `critical`. Reserve `critical` for a broad delivery, security, reliability, or production blocker with no reasonable workaround.

Assign `risk` as `low`, `medium`, or `high`, based on cross-cutting impact, data or infrastructure changes, dependency uncertainty, rollout complexity, and reversibility.

Write `.ai-pilot/output/technical-analysis.json` with exactly:

```json
{
  "priority": "low | medium | high | critical",
  "risk": "low | medium | high",
  "rationale": "A single 2–4 sentence explanation"
}
```

The file must contain valid JSON with no comments or trailing commas. Do not ask questions; analyze the supplied context and write the result autonomously.
