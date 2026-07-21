---
name: technical-analysis
description: Evaluates a technical backlog item (TBI) and produces a structured priority/risk analysis covering complexity, risk, dependencies, and effort.
---

# Technical Analysis — Foundation

Evaluate a technical backlog item and produce a structured analysis to support implementation planning.

## Inputs

Load the TBI description, acceptance criteria, and business rules from the current context.

## Analysis framework

Score each dimension 1–5:

| Dimension | 1 | 5 |
|-----------|---|---|
| **Technical complexity** | Single file change | Cross-cutting architecture change |
| **Risk to existing functionality** | No existing code touched | Core platform component changed |
| **External dependencies** | None | Multiple external systems |
| **Team knowledge** | Well-understood pattern | Novel technology or unknown domain |
| **Testability** | Unit testable | Requires complex integration setup |

## Output format

```
## Technical Analysis

**TBI:** [TBI ID and title]

### Scores
| Dimension | Score | Rationale |
|-----------|-------|-----------|
| Technical complexity | X/5 | ... |
| Risk to existing | X/5 | ... |
| External dependencies | X/5 | ... |
| Team knowledge | X/5 | ... |
| Testability | X/5 | ... |

**Effort estimate:** [S / M / L / XL]
**Risk level:** [High / Medium / Low]
**Implementation wave recommendation:** [Wave N — rationale]

### Key technical decisions required
- ...

### Dependencies on other TBIs or PBIs
- ...

### Risks and mitigations
- ...

### Definition of done
- [ ] ...
```
