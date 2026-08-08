---
name: update-changelog
description: Project adapter for update-changelog. Customize for your project.
---

# update-changelog — Project Adapter


- Project: {{slot:projectName}}
- Changelog: `{{slot:changelogFile}}` (newest entries first)
- Version sync: add a migration (if applicable) that updates the current changelog version in the project's settings store
- Versioning: semver (major.minor.patch)
