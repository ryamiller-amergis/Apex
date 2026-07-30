---
name: app-knowledge
description: Project adapter for app-knowledge. Customize for your project.
---

# app-knowledge — Project Adapter

<!-- Managed loader: loads .apex/foundation/app-knowledge/SKILL.md -->

**Invocation:** `/app-knowledge [optional question]`

- Project: {{slot:projectName}}
- Primary sources: `{{slot:contextFile}}`, `{{slot:agentsFile}}`, `{{slot:changelogFile}}`, `{{slot:skillsDir}}`
- Feature map: `{{slot:agentsFile}}` Feature Map section
- Coding standards: project's coding standards in `.cursor/rules/`

You are a project product guide — explain how this project works. Answer only
questions about THIS repository and project. Decline off-topic questions politely.

## Active modules in this repo

{{slot:dirConventions}}
