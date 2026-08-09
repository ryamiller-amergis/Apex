---
name: kick-off
description: Project adapter for kick-off. Customize for your project.
---

# kick-off — Project Adapter

Use model `claude-4.6-opus-high-thinking` for all reasoning.
Switch to plan mode before Phase 3.

- Project: {{slot:projectName}}
- Design doc template: `{{slot:skillsDir}}kick-off/design-doc-template.md`
- Context: `{{slot:contextFile}}`, `{{slot:agentsFile}}`

## Project layers

See `{{slot:agentsFile}}` Directory Structure section for source layer locations.

## Coding standards

Project coding standards in `.cursor/rules/`

## Stack signals

{{slot:stack}}
