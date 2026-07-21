---
name: feature-request-analysis
description: Project adapter for feature-request-analysis. Loads the generic foundation and binds it to this project's mission, feature set, and file locations.
---

# Feature Request Analysis — Project Adapter

<!-- Managed loader: loads .apex/foundation/feature-request-analysis/SKILL.md -->
Applies the generic feature-request-analysis method to this project.

- Project: {{slot:projectName}}
- Input: `.ai-pilot/kickoff-context.md` (fields: title, request, advantage)
- Output: `.ai-pilot/output/feature-request-analysis.json`

Assess Alignment against this project's mission and existing capabilities. Use
the project's own glossary/feature vocabulary where available:

{{slot:glossary}}

<!-- TODO(mission): summarize this product's mission in one sentence for alignment scoring -->
