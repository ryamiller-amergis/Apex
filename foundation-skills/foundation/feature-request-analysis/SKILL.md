---
name: feature-request-analysis
description: Project-agnostic method for evaluating a product feature request across clarity, feasibility, impact, and alignment, producing a structured priority/risk analysis as JSON. Product framing and file locations come from the adapter.
---

# Feature Request Analysis — Foundation (project-agnostic)

Evaluate a product feature request and produce a structured analysis. The
adapter supplies the product's mission, existing feature set, and file locations.

## Evaluate four dimensions

1. **Clarity** — Is the request well-defined? Are the problem and desired outcome clear enough to build from?
2. **Feasibility** — Achievable within the product's architecture? Does it need new infrastructure, integrations, or fundamental change? Complexity (small/medium/large)?
3. **Impact** — How many users benefit? Frequent pain point or edge case? Improves retention, onboarding, or daily workflow?
4. **Alignment** — Does it fit the product's mission and complement existing features without conflict or duplication?

## Priority

Assign `low`, `medium`, `high`, or `critical`:

| Priority | Criteria |
|----------|----------|
| critical | Blocks core workflows for many users; no workaround exists |
| high | Significant improvement to a common workflow; strong demand signal |
| medium | Useful enhancement; moderate or subset-limited impact |
| low | Nice-to-have; minimal impact, niche use, or easy workaround |

Weight: user impact (40%), frequency of similar requests (30%), implementation
complexity as inverse weight (30% — higher complexity lowers priority unless impact is critical).

## Risk

Assign `low`, `medium`, or `high`, considering technical complexity, scope-creep
potential, dependency risk, and reversibility.

## Rationale

2-4 sentences: why these levels, the most important factors, and any caveats
(e.g. "priority would increase if X").

## Output

Write exactly this JSON shape (valid JSON, no comments or trailing commas;
`rationale` is a single string with no newlines):

```json
{
  "priority": "low | medium | high | critical",
  "risk": "low | medium | high",
  "rationale": "string explaining the assessment"
}
```

Do not ask questions. Read the input, analyze, write the output autonomously.
