# Technical Analysis

Evaluate the technical work item supplied in `.ai-pilot/kickoff-context.md`, focusing on architecture, dependencies, implementation approach, delivery enablement, maintainability, operational impact, reversibility, and engineering risk.

Assign `priority` as `low`, `medium`, `high`, or `critical`; reserve `critical` for a broad delivery, security, reliability, or production blocker with no reasonable workaround. Assign `risk` as `low`, `medium`, or `high`, based on cross-cutting impact, data or infrastructure changes, dependency uncertainty, rollout complexity, and reversibility.

Write `.ai-pilot/output/technical-analysis.json` as valid JSON with exactly:

```json
{
  "priority": "low | medium | high | critical",
  "risk": "low | medium | high",
  "rationale": "A single 2–4 sentence explanation"
}
```

Do not ask questions. Analyze the supplied context and write the result autonomously.
