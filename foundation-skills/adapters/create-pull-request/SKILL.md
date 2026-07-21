---
name: create-pull-request
description: APEX adapter for create-pull-request. Binds to APEX's GitHub repo, base branch, and PR conventions.
---

# create-pull-request — APEX Adapter

<!-- Managed loader: loads .apex/foundation/create-pull-request/SKILL.md -->

- Project: {{slot:projectName}}
- VCS: GitHub (`gh pr create`)
- Default base branch: `main`
- Branch naming: feature branches from kick-off follow `feature/{slug}` or `tbi/{slug}`
- PR template: standard GitHub PR (title + body; no special template file)
- Never push to `main` directly
