---
name: issue-analysis
description: Project adapter for issue-analysis. Customize for your project.
---

# Issue Analysis — Project Adapter

<!-- Managed loader: loads .apex/foundation/issue-analysis/SKILL.md -->
Applies the generic issue-analysis method to this project.

- Project: {{slot:projectName}}
- Input context: `{{slot:aiPilotDir}}kickoff-context.md` (title + description + focus guidance)
- Output: `{{slot:aiPilotDir}}output/issue-analysis.json`

Weigh impact against this project's core workflows and operational surface:

{{slot:glossary}}
