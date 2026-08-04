---
name: postgresql-migrations
description: Project adapter for postgresql-migrations. Customize for your project.
---

# postgresql-migrations — Project Adapter

<!-- Managed loader: loads .apex/foundation/postgresql-migrations/SKILL.md -->

- Project: {{slot:projectName}}
- Migration tool: project's migration tool (e.g. `node-pg-migrate`, SQL files in project's migrations directory)
- Create: `npm run migrate:create -- <name>` (or project's equivalent)
- Apply: `npm run migrate:up` / `npm run migrate:local:up` (or project's equivalent)
- ORM schema: project's ORM schema file (see {{slot:agentsFile}} Directory Structure)
- DB conventions: project's DB conventions in `.cursor/rules/`
