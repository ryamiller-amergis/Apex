---
name: technical-analysis
description: Project adapter for technical-analysis. Customize for your project.
---

# Technical Analysis — Project Adapter

<!-- Managed loader: loads .apex/foundation/technical-analysis/SKILL.md -->
Applies the generic technical-analysis method to this project.

- Project: {{slot:projectName}}
- Input context: `{{slot:aiPilotDir}}kickoff-context.md` (title + description + focus guidance)
- Output: `{{slot:aiPilotDir}}output/technical-analysis.json`

Weigh architectural fit against this project's stack and conventions:

{{slot:stack}}
