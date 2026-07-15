---
name: Issue Analysis
description: Evaluates a reported issue and produces a structured priority/risk analysis
---

# Issue Analysis

Evaluate the issue supplied in `.ai-pilot/kickoff-context.md`. The context contains its title and description plus guidance to focus on impact, likely severity, reproducibility clues, operational risk, and urgency.

Assess:

- affected workflow and likely breadth of user or system impact;
- evidence about frequency, reproducibility, regression risk, and available workarounds;
- potential for data loss, security exposure, service degradation, or blocked delivery;
- likely diagnostic and remediation complexity, dependencies, and safe rollback options.

Assign `priority` as `low`, `medium`, `high`, or `critical`. Reserve `critical` for active security exposure, data loss, widespread outage, or a core workflow blocker without a workaround.

Assign `risk` as `low`, `medium`, or `high`, reflecting uncertainty, blast radius, remediation complexity, sensitive data or auth impact, and regression potential.

Write `.ai-pilot/output/issue-analysis.json` with exactly:

```json
{
  "priority": "low | medium | high | critical",
  "risk": "low | medium | high",
  "rationale": "A single 2–4 sentence explanation"
}
```

The file must contain valid JSON with no comments or trailing commas. Do not ask questions; analyze the supplied context and write the result autonomously.
