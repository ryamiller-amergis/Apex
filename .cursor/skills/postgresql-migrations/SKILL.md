---
name: postgresql-migrations
description: Guides creation and management of PostgreSQL schema migrations using node-pg-migrate in this project. Use when adding a new table, altering a column, creating an index, fixing migration order conflicts, or when the user asks about database schema changes, EF migrations equivalent, "how do I add a column", or "how do I create a table".
disable-model-invocation: true
---

# PostgreSQL Migrations (node-pg-migrate)

This project uses `node-pg-migrate` with the `pg` driver. Migrations are plain SQL files in `migrations/`.

## Agent workflow — the AI never picks the filename

The filename is **always** determined by a command run in the terminal. Do not invent timestamps or write `migrations/20260618….sql` directly.

### Schema changes (tables, columns, indexes)

```bash
npm run migrate:local:create -- add-work-items-table
```

The CLI prints the exact path, e.g.:

```text
Created migration -- …/migrations/1781818427336_add-work-items-table.sql
```

**Then edit that file.** The slug in the command becomes the suffix; the timestamp prefix is assigned automatically.

### Hand-written SQL only (changelog sync, data backfills)

When you must create the file yourself (no CLI scaffold):

```bash
node scripts/next-migration-timestamp.mjs sync-changelog-version-1-28-0
# → migrations/20260618140200_sync-changelog-version-1-28-0.sql
```

Create **that exact path** and write the SQL. For a second migration in the same change, run the command again (it bumps by 100).

### Multiple migrations in one PR

Run `migrate:local:create` (or the timestamp helper) **once per file**, in order. Never reuse a timestamp or rename after creation.

## Create a migration (always use the CLI)

**Never hand-pick a timestamp or rename a migration file after it has run.** Filenames are the source of truth for ordering; `pgmigrations` stores the exact filename applied.

```bash
# Local dev (preferred — reads .env.local)
npm run migrate:local:create -- add-work-items-table

# Cloud / generic
npm run migrate:create -- add-work-items-table
```

### Before writing a hand-crafted SQL file

Some flows (e.g. changelog sync) add SQL without `migrate:create`. **Run the helper with the slug** — it returns the full path to create:

```bash
node scripts/next-migration-timestamp.mjs sync-changelog-version-1-28-0
# → migrations/20260618140200_sync-changelog-version-1-28-0.sql
```

For multiple related migrations in one change, run the helper again for each slug (timestamps increment by **100** automatically).

### Rules that prevent order conflicts

| Do | Don't |
|---|---|
| Use `migrate:local:create` for schema changes | Guess timestamps like `20260618130000` |
| Keep the filename forever once applied anywhere | Rename a migration to "fix" ordering |
| Add new migrations with timestamps **after** the latest file | Insert a migration between two already-applied ones |
| Delete mistaken **unapplied** files and recreate via CLI | Add placeholder files to "match" a DB row you guessed wrong |

### Verify before committing

```bash
npm run migrate:local:up    # must succeed with no order errors
```

If `migrate:local:up` fails with **"preceding already run migration"**, filenames on disk no longer match `pgmigrations`. Fix by restoring the original filenames (see Troubleshooting below) — do not rename applied migrations forward.

## Migration file structure

```sql
-- Up Migration
CREATE TABLE work_items (
  id          SERIAL PRIMARY KEY,
  ado_id      INTEGER NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  state       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Down Migration
DROP TABLE IF EXISTS work_items;
```

## Apply / roll back

```bash
npm run migrate:up      # apply all pending migrations
npm run migrate:down    # roll back the last migration
```

`node-pg-migrate` reads `DATABASE_URL` from the environment automatically — same variable used by `src/server/db.ts`.

## Environment targets

| Target | Command | Reads from |
|---|---|---|
| **Local DB** | `npm run migrate:local:up` | `.env.local` → `localhost:5432/aipilot` |
| **Cloud dev DB** | `npm run migrate:up` | `.env` → Azure `DATABASE_URL` |
| **Production** | Run in CI/CD pipeline before `npm start` | App Service env var |

Always test migrations locally first:
```bash
# 1. scaffold
npm run migrate:local:create -- add-my-table

# 2. test locally
npm run migrate:local:up

# 3. verify, then roll back if needed
npm run migrate:local:down

# 4. once happy, apply to cloud dev
npm run migrate:up
```

## After the migration — update the Drizzle schema

This project uses Drizzle ORM as the query layer. After writing a migration, **always update `src/server/db/schema.ts`** to match — Drizzle does not own or generate migrations here; it only reads the schema definitions for type safety.

**New table example:**
```typescript
// src/server/db/schema.ts
export const workItems = pgTable('work_items', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  adoId: integer('ado_id').notNull().unique(),
  title: text('title').notNull(),
  state: text('state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});
```

**New column example** (after `ALTER TABLE … ADD COLUMN`):
```typescript
// Add the new field to the existing pgTable definition in schema.ts
assignedTo: text('assigned_to'),
```

**Add a relation** whenever there is a FK — this enables `db.query.*` eager loading:
```typescript
export const workItemsRelations = relations(workItems, ({ one }) => ({
  sprint: one(sprints, { fields: [workItems.sprintId], references: [sprints.id] }),
}));
```

Then run `npx tsc -p tsconfig.server.json --noEmit` to verify no type errors before committing.

`.env.local` is git-ignored. If it doesn't exist, create it:
```
DATABASE_URL=postgresql://pgadmin:yourpassword@localhost:5432/aipilot
```
One-time DB setup if the local database doesn't exist yet:
```bash
createdb -U pgadmin aipilot
# or in psql: CREATE DATABASE aipilot;
```

## Common patterns

**Add a column safely:**
```sql
-- Up
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS assigned_to TEXT;

-- Down
ALTER TABLE work_items DROP COLUMN IF EXISTS assigned_to;
```

**Add an index (non-blocking):**
```sql
-- Up
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_work_items_state ON work_items(state);

-- Down
DROP INDEX IF EXISTS idx_work_items_state;
```

**Foreign key:**
```sql
-- Up
ALTER TABLE sprints ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL;

-- Down
ALTER TABLE sprints DROP COLUMN IF EXISTS team_id;
```

**Rename a column:**
```sql
-- Up
ALTER TABLE work_items RENAME COLUMN old_name TO new_name;

-- Down
ALTER TABLE work_items RENAME COLUMN new_name TO old_name;
```

## .NET EF equivalent commands

| EF Migrations | node-pg-migrate |
|---|---|
| `dotnet ef migrations add Name` | `npm run migrate:create -- name` |
| `dotnet ef database update` | `npm run migrate:up` |
| `dotnet ef migrations revert` | `npm run migrate:down` |

The main difference: EF generates C# from your model diff; `node-pg-migrate` uses SQL files you write by hand. The SQL gives you full control with no magic.

## Troubleshooting order conflicts

**Error:** `Not run migration X is preceding already run migration Y`

This means a file on disk has timestamp X (not in `pgmigrations`) while Y is already recorded as applied. Common causes:

1. **Renamed after apply** — e.g. DB has `20260618121500_add-model-audit-columns` but the file was renamed to `20260618130100_…`. **Fix:** rename the file back to match `pgmigrations.name` exactly.
2. **Wrong placeholder** — a guessed filename collides with an applied migration at the same timestamp. **Fix:** delete the unapplied placeholder; do not change the applied migration's name.
3. **Timestamp behind latest applied** — new file timestamp is earlier than migrations already run on that database. **Fix:** delete the unapplied file, run `node scripts/next-migration-timestamp.mjs`, recreate with the new timestamp.

**Inspect what the database thinks is applied (local):**

```bash
npx dotenv -e .env.local -- node -e "import pg from 'pg'; const c=new pg.Client({connectionString:process.env.DATABASE_URL}); await c.connect(); const r=await c.query('SELECT name FROM pgmigrations ORDER BY name DESC LIMIT 10'); console.log(r.rows.map(x=>x.name).join('\n')); await c.end();"
```

Every `name` in that list must have a matching file in `migrations/`. Pending files must sort **after** the last applied name.
