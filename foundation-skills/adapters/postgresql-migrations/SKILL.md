---
name: postgresql-migrations
description: APEX adapter for postgresql-migrations. Binds to APEX's node-pg-migrate + Drizzle setup.
---

# postgresql-migrations — APEX Adapter

<!-- Managed loader: loads .apex/foundation/postgresql-migrations/SKILL.md -->

- Project: {{slot:projectName}}
- Migration tool: `node-pg-migrate` (SQL files in `migrations/`)
- Create: `npm run migrate:create -- <name>`
- Apply: `npm run migrate:up` / `npm run migrate:local:up`
- ORM schema: `src/server/db/schema.ts` (Drizzle ORM — keep in sync after every migration)
- DB conventions: `.cursor/rules/postgresql-db.mdc`
