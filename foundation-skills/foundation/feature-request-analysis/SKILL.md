---
name: feature-request-analysis
description: Evaluates a product feature request and produces a structured priority/risk analysis with impact, effort, and risk scores.
---

# Feature Request Analysis — Foundation

Evaluate a feature request and produce a structured analysis to support prioritization decisions.

## Inputs

Load the feature request description from the current context or the project's feature request system.

## Analysis framework

Score each dimension 1–5:

| Dimension | 1 | 5 |
|-----------|---|---|
| **User impact** | Affects <1% of users | Affects >50% of users or core workflow |
| **Business value** | Nice-to-have | Critical differentiator or revenue driver |
| **Implementation effort** | Hours | Months |
| **Technical risk** | Well-understood | Novel or high-dependency |
| **Strategic alignment** | Tangential | Core product direction |

## Output format

```
## Feature Request Analysis

**Title:** [Feature name]
**Requested by:** [Source]

### Scores
| Dimension | Score | Rationale |
|-----------|-------|-----------|
| User impact | X/5 | ... |
| Business value | X/5 | ... |
| Implementation effort | X/5 | ... |
| Technical risk | X/5 | ... |
| Strategic alignment | X/5 | ... |

**Priority recommendation:** [High / Medium / Low / Defer]
**Confidence:** [High / Medium / Low]

### Key considerations
- ...

### Risks and dependencies
- ...

### Open questions
- ...
```

## Guidance

- Be concrete about user impact: which personas, which workflows, what frequency.
- Surface hidden costs: maintenance burden, support overhead, downstream dependencies.
- Call out requirements that are likely to change before delivery.
- Recommend deferral when strategic alignment is unclear, not just when effort is high.
