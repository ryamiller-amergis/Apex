# Issue Analysis

Evaluate the issue supplied in `.ai-pilot/kickoff-context.md`, focusing on affected workflows, user and system impact, severity, frequency, reproducibility clues, workarounds, data or security exposure, operational risk, and remediation urgency.

Assign `priority` as `low`, `medium`, `high`, or `critical`; reserve `critical` for active security exposure, data loss, widespread outage, or a core workflow blocker without a workaround. Assign `risk` as `low`, `medium`, or `high`, reflecting uncertainty, blast radius, remediation complexity, sensitive data or auth impact, and regression potential.

Write `.ai-pilot/output/issue-analysis.json` as valid JSON with exactly:

```json
{
  "priority": "low | medium | high | critical",
  "risk": "low | medium | high",
  "rationale": "A single 2–4 sentence explanation"
}
```

Do not ask questions. Analyze the supplied context and write the result autonomously.
