# Database migrations

The starter keeps one example table, `app_users`, in PostgreSQL. Drizzle Kit
generates SQL migrations from `apps/api/src/persistence/schema.ts`, and the
SQL is reviewed and committed with the schema change. The application never
changes the schema when it starts. Only the standalone `migrate` command does.

This `app_users` table belongs to the starter. It is unrelated to any table of
the same name in the repository the template came from.

Run every command from the workspace root.

## Ownership

- The application repository owns the migration files.
- Platform Engineering owns running them in every shared environment.
- A schema change ships in one pull request: the edit to `schema.ts`, the
  generated SQL, and the files under `apps/api/drizzle/meta/`.
- Advice for Platform Engineering: give the migration command a role that can
  change the schema, and give the running application a role that can only read
  and write data. The template cannot enforce this.

## Workflow

1. Edit `apps/api/src/persistence/schema.ts`.
2. Generate the migration. Use a short slug that says what changes.

   ```sh
   pnpm db:generate -- --name add_phone_number
   ```

   This writes `apps/api/drizzle/NNNN_add_phone_number.sql`, updates the
   journal and snapshot under `apps/api/drizzle/meta/`, and formats the JSON
   with Prettier.

3. Read the SQL. Edit the schema and regenerate rather than editing the SQL.
4. Check that the schema and the committed migrations agree. This needs no
   database.

   ```sh
   pnpm migrate:validate
   ```

   It prints `Migrations match the Drizzle schema.` and exits 0, or prints
   `Schema differs from committed migrations. Run "pnpm db:generate" and commit the result.`
   followed by the SQL the missing migration would contain, and exits 1.

5. Apply it to your local database with `pnpm migrate`, then commit the schema
   and the generated files together.

Rules:

- Never rename, edit, or delete a migration that has been applied anywhere
  outside your machine.
- Make every change backward compatible with the version still serving
  traffic. The command runs before traffic switches, so the previous release
  runs against the new schema for a while. Expand first (add a nullable column,
  backfill, switch the code), then contract in a later release (drop the old
  column).
- When two pull requests both add a migration, the journal
  `apps/api/drizzle/meta/_journal.json` conflicts. The later pull request
  deletes its generated SQL and snapshot, reverts its journal entry, rebases,
  and runs `pnpm db:generate` again. `pnpm migrate:validate` catches a wrong
  merge.

## Running the migration command

| Where                  | Command                    |
| ---------------------- | -------------------------- |
| Source checkout        | `pnpm migrate`             |
| Built API (`apps/api`) | `node dist/cli/migrate.js` |

The command reads `NODE_ENV` and `DATABASE_URL` from the environment and
nothing else. In a checkout, `pnpm migrate` also loads `.env` when it exists.
It never prints the connection URL or a password.

The built command reads SQL from `apps/api/drizzle/`, next to `dist/`. An image
that runs it must contain both `dist/cli/migrate.js` and the `drizzle/` folder.
Drizzle Kit is a development tool and is not needed to apply migrations.

| Exit | Meaning                                                  | Example output                                                         |
| ---- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| 0    | Pending migrations applied, or nothing pending           | `Applied 1 migration: 0000_init_app_users` or `No pending migrations.` |
| 1    | A migration failed, or the database could not be reached | `Migration 0001_add_phone failed: 42703 column "x" does not exist`     |
| 2    | `NODE_ENV` or `DATABASE_URL` is missing or malformed     | `Configuration error: DATABASE_URL is missing.`                        |

How a run behaves:

- Each pending file runs in its own transaction and is recorded in
  `drizzle.__drizzle_migrations`. When a file fails, its changes roll back,
  earlier files stay applied, and the next run starts again at the failing
  file.
- A PostgreSQL advisory lock serializes runs. Two runs started together queue;
  the second finds nothing pending.
- Running again after success changes nothing and exits 0.
- Error output names the SQLSTATE code and the PostgreSQL message only. Read the
  database log for detail.
- TLS settings go in the connection string or the standard `PG*` variables.
- PostgreSQL 13 or later is required. Local Compose uses `postgres:16`.

## Rollback

Production rollback is forward-only: ship a new corrective migration. There are
no down migrations, and Drizzle Kit does not generate them.

To reset a local database, remove the Compose volume and migrate again:

```sh
docker compose down -v
pnpm db:up
pnpm migrate
```

## Seed data

`pnpm seed` inserts three synthetic `app_users` rows into a local database.
Subjects start with `seed-user-`, names start with `Sample Person`, and emails
use `example.com`. Never add real personal data.

- The seed inserts missing rows and never updates an existing one. Running it
  again prints `Seeded 0 new rows; 3 already present.`
- It refuses to run when `NODE_ENV` is `production`, before it connects.
- On a database with no migrations it prints
  `The app_users table does not exist. Run "pnpm migrate" first.` and exits 1.
- It does not seed shared environments.
