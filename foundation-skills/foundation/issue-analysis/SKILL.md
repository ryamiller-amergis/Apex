---
name: issue-analysis
description: Evaluates a reported issue and produces a structured priority/risk analysis to support triage and response decisions.
---

# Issue Analysis — Foundation

Evaluate a reported issue and produce a structured triage analysis.

## Inputs

Load the issue description from the current context or the project's issue tracking system.

## Analysis framework

Score each dimension 1–5:

| Dimension | 1 | 5 |
|-----------|---|---|
| **Severity** | Cosmetic / minor inconvenience | Data loss or security breach |
| **User impact** | Affects <1% of users | Affects all users or core workflow |
| **Frequency** | Rare / hard to reproduce | Happens on every use |
| **Workaround available** | Easy workaround exists | No workaround |
| **Root cause clarity** | Unknown / complex | Clearly identified |

## Output format

```
## Issue Analysis

**Title:** [Issue name]
**Reported by / Source:** [Source]

### Scores
| Dimension | Score | Rationale |
|-----------|-------|-----------|
| Severity | X/5 | ... |
| User impact | X/5 | ... |
| Frequency | X/5 | ... |
| Workaround | X/5 | ... |
| Root cause clarity | X/5 | ... |

**Priority recommendation:** [Critical / High / Medium / Low]
**Suggested SLA:** [Immediate / This sprint / Next sprint / Backlog]

### Root cause hypothesis
- ...

### Reproduction steps (if known)
1. ...

### Affected components
- ...

### Open questions
- ...
```

## Guidance

- Distinguish user-reported symptoms from root causes.
- Identify if the issue is data-related, code-related, or configuration-related.
- Check if similar issues have been reported before.
- Consider blast radius: what else could be affected by the same root cause.
