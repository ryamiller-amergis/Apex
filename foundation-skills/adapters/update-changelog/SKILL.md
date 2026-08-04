---
name: update-changelog
description: Project adapter for update-changelog. Customize for your project.
---

# update-changelog — Project Adapter

<!-- Managed loader: loads .apex/foundation/update-changelog/SKILL.md -->

- Project: {{slot:projectName}}
- Changelog: `{{slot:changelogFile}}` (newest entries first)
- Version sync: add a migration (if applicable) that updates the current changelog version in the project's settings store
- Versioning: semver (major.minor.patch)
