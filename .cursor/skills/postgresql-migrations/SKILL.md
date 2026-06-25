---
name: postgresql-migrations
description: Guides creation and management of PostgreSQL schema migrations using node-pg-migrate in this project. Use when adding a new table, altering a column, creating an index, fixing migration order conflicts, or when the user asks about database schema changes, EF migrations equivalent, "how do I add a column", or "how do I create a table".
disable-model-invocation: true
---

# PostgreSQL Migrations (node-pg-migrate)

This project uses `node-pg-migrate` with the `pg` driver. Migrations are plain SQL files in `migrations/`.

## Critical — do not use `migrate:create`

**Never run `npm run migrate:create` or `npm run migrate:local:create` in this repo.**

Those commands call `node-pg-migrate create`, which assigns an **epoch-millisecond** prefix (e.g. `1782406145007_…`). This repo's applied migrations use **`YYYYMMDDHHMMSS`** prefixes (e.g. `20260625150100_…`). Numerically, epoch-ms (~1.78×10¹²) sorts **before** date-stamped (~2.02×10¹³) names, so new CLI migrations fail with:

```text
Not run migration 1782402822050_… is preceding already run migration 20260518202500_…
```

**Always** allocate the filename with `scripts/next-migration-timestamp.mjs` (see below).

## Agent workflow — filename from the helper only

The agent **must** run the helper in the terminal and create **exactly** the path it prints. Do not guess timestamps, use `Date.now()`, or write `migrations/20260618….sql` by hand.

### Step 1 — allocate the filename

```bash
node scripts/next-migration-timestamp.mjs add-my-table
# → migrations/20260625150200_add-my-table.sql
```

For a second migration in the same change, run the helper again (timestamps bump by **100** automatically):

```bash
node scripts/next-migration-timestamp.mjs add-my-table-index
# → migrations/20260625150300_add-my-table-index.sql
```

### Step 2 — create the file at that path

Create the printed path and write the SQL (Up + Down sections). Use the Write tool or shell — the path must match the helper output character-for-character.

### Step 3 — apply and verify

```bash
npm run migrate:local:up    # preferred — reads .env.local
# or
npm run migrate:up        # uses .env DATABASE_URL
```

### Step 4 — update Drizzle schema

Update `src/server/db/schema.ts` to match, then:

```bash
npx tsc -p tsconfig.server.json --noEmit
```

## Rules that prevent order conflicts

| Do | Don't |
|---|---|
| Run `node scripts/next-migration-timestamp.mjs <slug>` before every new file | Run `npm run migrate:create` / `migrate:local:create` |
| Keep the filename forever once applied anywhere | Rename a migration to "fix" ordering |
| Ensure pending files sort **after** the latest applied name | Insert a timestamp between two already-applied migrations |
| Delete mistaken **unapplied** files and re-run the helper | Add placeholder files to "match" a guessed DB row |
| Keep on-disk files for every row in `pgmigrations` | Delete migration files that were already applied |

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
# 1. allocate filename
node scripts/next-migration-timestamp.mjs add-my-table

# 2. create file at printed path, write SQL

# 3. test locally
npm run migrate:local:up

# 4. verify, then roll back if needed
npm run migrate:local:down

# 5. once happy, apply to cloud dev
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

| EF Migrations | This project |
|---|---|
| `dotnet ef migrations add Name` | `node scripts/next-migration-timestamp.mjs name` → create file → write SQL |
| `dotnet ef database update` | `npm run migrate:up` |
| `dotnet ef migrations revert` | `npm run migrate:down` |

The main difference: EF generates C# from your model diff; here you write SQL by hand. The SQL gives you full control with no magic.

## Troubleshooting order conflicts

**Error:** `Not run migration X is preceding already run migration Y`

Common causes:

1. **Used `migrate:create`** — file has epoch-ms prefix behind date-stamped applied migrations. **Fix:** delete the unapplied file, run `node scripts/next-migration-timestamp.mjs <slug>`, recreate at the new path.
2. **Renamed after apply** — DB has `20260618121500_add-model-audit-columns` but the file was renamed. **Fix:** rename the file back to match `pgmigrations.name` exactly.
3. **Missing file on disk** — migration applied in DB but `.sql` deleted. **Fix:** restore the file from git (`git checkout <commit> -- migrations/<name>.sql`).
4. **Duplicate timestamps** — two different slugs at the same prefix. **Fix:** delete the unapplied duplicate, re-run the helper.

**Inspect what the database thinks is applied (local):**

```bash
npx dotenv -e .env.local -- node -e "const pg=require('pg');(async()=>{const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();const r=await c.query('SELECT name FROM pgmigrations ORDER BY name DESC LIMIT 10');r.rows.forEach(x=>console.log(x.name));await c.end()})()"
```

Every `name` in that list must have a matching file in `migrations/`. Pending files must sort **after** the last applied name.
