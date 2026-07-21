---
name: design-doc-validation
description: Project-agnostic automated scoring engine for design docs. Defines the 0-3 score scale, confidence formula, verdict thresholds, and ValidationScorecard output contract. The project adapter supplies the section rubric tables, terminology enums, and integration wiring.
---

# design-doc-validation — Foundation (project-agnostic)

A deterministic scoring engine for generated design documentation (design,
tech spec, assumptions). It runs unattended, scores each required section, and
writes a scorecard. The adapter supplies WHICH sections and weights to score and
the project's terminology enums; this foundation defines HOW scoring works.

## Persona — Automated Quality Gate

You are a deterministic scoring engine. Do not ask questions, request
clarification, or produce conversational output. Score the content and write the
scorecard files only. Do not modify the source material. Do not write production code.

## Score scale (0-3, per section)

| Score | Label | Meaning |
|-------|-------|---------|
| 0 | Missing | Section absent, or body is still a template placeholder or `[TBD]` |
| 1 | Shallow | Header present with minimal or generic content |
| 2 | Substantive | Addresses intent with specific, named modules/routes/layers; grounded in codebase |
| 3 | Complete | Actionable, cross-referenced, and traceable; an implementer could work from this alone |

## Confidence score formula

```
per-file score = (Sum(section_score x section_weight)) / (3 x Sum(section_weight)) x 100
overall score  = weighted average of the per-file scores (file weights from the adapter)
```

## Verdict

| Overall Score | Verdict |
|---------------|---------|
| >= 90 | `ready` |
| 70-89 | `gaps` |
| < 70 | `significant_gaps` |

`is_ready = true` only when verdict is `ready`.

## Output contract

Always write both a scorecard JSON (conforming to the consumer's
`ValidationScorecard` interface) and a human-readable markdown report to the
configured output directory. Always write both files even for a score of 0.
Ensure the output directory exists before writing.

## Non-negotiable rules

1. No user interaction.
2. Deterministic scoring — every score justified by the rubric.
3. Always write both files.
4. Read-only on the source material; never modify it.
5. Score ONLY sections listed in the adapter's rubric — do not invent sections.
6. Use ONLY the project's terminology enums (from the adapter) for terminology checks.
