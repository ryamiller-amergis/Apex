---
name: update-changelog
description: APEX adapter for update-changelog. Binds to APEX's public/CHANGELOG.json and app_settings sync migration.
---

# update-changelog — APEX Adapter

<!-- Managed loader: loads .apex/foundation/update-changelog/SKILL.md -->

- Project: {{slot:projectName}}
- Changelog: `public/CHANGELOG.json` (newest entries first)
- Version sync: add a migration under `migrations/` that updates the current changelog version in `app_settings`
- Versioning: semver (major.minor.patch)
