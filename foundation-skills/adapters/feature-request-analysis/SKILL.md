---
name: feature-request-analysis
description: Project adapter for feature-request-analysis. Customize for your project.
---

# Feature Request Analysis — Project Adapter

<!-- Managed loader: loads .apex/foundation/feature-request-analysis/SKILL.md -->
Applies the generic feature-request-analysis method to this project.

- Project: {{slot:projectName}}
- Input: `{{slot:aiPilotDir}}kickoff-context.md` (fields: title, request, advantage)
- Output: `{{slot:aiPilotDir}}output/feature-request-analysis.json`

Assess Alignment against this project's mission and existing capabilities. Use
the project's own glossary/feature vocabulary where available:

{{slot:glossary}}

<!-- TODO(mission): summarize this product's mission in one sentence for alignment scoring -->
