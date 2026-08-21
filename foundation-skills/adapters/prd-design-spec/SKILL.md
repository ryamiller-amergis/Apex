---
name: prd-design-spec
description: Project adapter for prd-design-spec. Customize for your project.
---

# prd-design-spec — Project Adapter


**Invocation:** `/prd-design-spec {slug}`

- Project: {{slot:projectName}}
- Inputs: `{{slot:aiPilotDir}}output/{slug}.prd.md`, `{{slot:aiPilotDir}}output/{slug}.backlog.json`, `{{slot:contextFile}}`, `{{slot:agentsFile}}`
- Templates: `design-template.md`, `tech-spec-template.md`, `assumptions-template.md`
- Output dir: `{{slot:aiPilotDir}}output/{slug}-design-spec/`

## Project layers and ownership

See `{{slot:agentsFile}}` Directory Structure section for source layer locations.

## Coding-standard references

When a Feature touches the database: project's DB conventions in `.cursor/rules/`
When a Feature touches the frontend: project's frontend conventions in `.cursor/rules/`

## Personas and canonical terms

Use this project's own persona, surface, and term vocabulary where defined (see
{{slot:agentsFile}} Key Terminology section).
