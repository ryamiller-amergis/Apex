---
name: feature-request-analysis
description: Project adapter for feature-request-analysis. Customize for your project.
---

# Feature Request Analysis — Project Adapter

Applies the generic feature-request-analysis method to this project.

- Project: {{slot:projectName}}
- Input: `{{slot:aiPilotDir}}kickoff-context.md` (fields: title, request, advantage)
- Output: `{{slot:aiPilotDir}}output/feature-request-analysis.json`

Assess Alignment against this project's mission and existing capabilities. Use
the project's own glossary/feature vocabulary where available:

{{slot:glossary}}

{{slot:mission}}
