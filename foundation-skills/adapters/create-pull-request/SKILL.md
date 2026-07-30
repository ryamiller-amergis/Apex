---
name: create-pull-request
description: Project adapter for create-pull-request. Customize for your project.
---

# create-pull-request — Project Adapter

<!-- Managed loader: loads .apex/foundation/create-pull-request/SKILL.md -->

- Project: {{slot:projectName}}
- VCS: GitHub (`gh pr create`) or project's equivalent VCS tool
- Default base branch: `main` (or project's default branch)
- Branch naming: feature branches follow `feature/{slug}` or `tbi/{slug}` (or project's convention)
- PR template: project's PR template (if present)
- Never push to the default branch directly
