# Assumptions & Unresolved Items — Starter Persistence with app_users

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> Shared between [design-doc-design.md](design-doc-design.md) and [design-doc-tech-spec.md](design-doc-tech-spec.md).
> Resolve all ⚠ items before implementation begins.

---

## Unresolved Items

Items that could not be inferred from the PRD, backlog, or codebase. Each must be decided before the relevant implementation step starts.

- ⚠ **Naming the failing migration**: PBI-004 (b) requires the migration command to "report the failing migration". Drizzle's own `migrate()` runs all pending migrations in one transaction and, as far as I know, does not name the failing file. This blocks step S4 (migration runner) and the assert in VT-12. Default used in this spec: the command applies pending migrations one file at a time, each in its own transaction, using `readMigrationFiles` from `drizzle-orm/migrator` and the same `drizzle.__drizzle_migrations` bookkeeping table. Earlier files stay applied when a later file fails. The alternative is to wrap `migrate()` and report the whole pending batch as rolled back, which meets the AC only loosely. The team must confirm the default, and the S4 implementer must check the pinned `drizzle-orm` version's migrator behavior first.

- ⚠ **Where Platform Engineering runs the migration command from**: PBI-004 gives Platform Engineering one standalone command to run before traffic switches, but the template ships no pipeline and the production container belongs to the Supply-Chain Baseline and Production Container feature (FEAT-013). If the container omits `dist/cli/migrate.js` and `apps/api/drizzle/`, the command can run only from a source checkout. This blocks the runbook text in S10 and the container feature's file list. Default used in this spec: Platform Engineering runs the same production image with a command override, and the container definition copies the compiled CLI and the SQL folder. Drizzle Kit is a dev dependency and is not needed to apply migrations. The owner of the container feature must confirm both files ship in the image.

- ⚠ **Create-on-first-access is unconfirmed**: The PRD lists "GET /api/v1/me creates the app_users row on first authenticated access" under assumptions with "Confirm this behavior." The data-access `create` operation is called from the request path only if that holds. It decides whether the profile service (FEAT-006, TBI-015) must handle a unique-constraint race. Default used in this spec: confirmed. `create` stays strict and throws `ProfileConflictError` on a duplicate subject. The profile service must catch that error and call `findBySubject` again, so two simultaneous first requests both succeed. The product owner must confirm the behavior, and the FEAT-006 implementer must add the retry.

- ⚠ **Seed row for the development principal**: The development adapter returns one fixed synthetic principal (FEAT-005, TBI-013). No endpoint lists users, so seeded rows are reachable through the API only if one seed row carries that principal's subject. FEAT-003 ships before FEAT-005 (implementation phase 2 against phase 3), so the seed cannot import the adapter's constant. Default used in this spec: the seed does not include the development principal. The first `GET /api/v1/me` as that principal then shows create-on-first-access, and seeded rows serve direct database inspection and tests. The team must decide whether FEAT-005 adds a seed row for its principal and exports its subject constant from one place.

- ⚠ **Data classification of the example fields**: The PRD leaves the classification of display name, email, and external identity subject to Platform Engineering. A "restricted" classification could add column encryption, a retention rule, or a different log policy, and that would change the schema and the first migration. Default used in this spec: plaintext columns, identity values redacted in logs and errors, synthetic data only in seeds and tests, and no encryption. Platform Engineering must classify the fields. The template ships the extension point, and a later forward migration can change a column.

---

## Assumptions Accepted

Inferences made during synthesis that were treated as resolved. Confirm these with stakeholders before implementation locks.

- **Output file layout**: The kickoff instruction asks for `design-doc-design.md`, `design-doc-tech-spec.md`, and `design-doc-assumptions.md` directly in `.ai-pilot/output/`. The skill text names `{slug}-design-spec/{feature-slug}-*.md`. This run follows the kickoff instruction and uses `design-doc` as the feature slug in cross-links. Risk: a downstream step that looks for the skill's path finds nothing.

- **Template workspace layout**: FEAT-001 (TBI-001) fixes five members but not their folder names. This spec assumes `templates/full-stack-express/` with `apps/api`, `apps/web`, `packages/contracts`, `packages/ui`, and `packages/config`. Risk: if FEAT-001 picks other names, every path in the tech spec shifts and nothing else changes.

- **Data-access module is a folder, not a sixth package**: TBI-006 calls it a "deep module" while FEAT-001 fixes five workspace members. The module lives at `apps/api/src/persistence/` and exposes one `index.ts`. An ESLint `no-restricted-imports` rule keeps `drizzle-orm`, `pg`, and `drizzle-kit` imports inside that folder. Risk: a separate package would give a stronger boundary but breaks the five-member rule.

- **Environment variable names**: The database connection value is `DATABASE_URL` (the same name Apex uses per `postgresql-db.mdc`), and the environment indicator is `NODE_ENV` with values `development`, `test`, and `production`. FEAT-002 (TBI-004) owns the full schema; this Feature adds a narrow `databaseEnvSchema` that the migrate and seed commands use alone, so Platform Engineering need not set authentication or telemetry variables to migrate. Risk: if FEAT-002 chooses other names, the CLI and the seed guard change in one place.

- **Column limits**: `external_subject` up to 255 characters (the OpenID Connect `sub` limit), `display_name` up to 100, `email` up to 254 (the mail address limit). The shared route definitions (FEAT-004, TBI-009) must set limits at or below these. Risk: a contract limit above a column limit turns a validation error into a database error.

- **Status values**: The PRD asks implementation to choose a small documented set. This spec picks `active` (default) and `disabled`, stored as text with a CHECK constraint rather than a PostgreSQL enum, because a forward corrective migration can change a CHECK constraint more easily than an enum type. No endpoint changes `status`. Risk: the team wants a different set before the first migration ships.

- **Timestamp handling**: Columns are `timestamptz`. The data-access module returns `Date` objects, and the profile service converts them to ISO strings at the contract boundary. This differs from Apex's `{ mode: 'string' }` convention in `postgresql-db.mdc`, which exists to match Apex's shared types. The template has no such types in the data layer. Risk: low; the choice is local to the module.

- **Script names**: FEAT-002 (TBI-005) already names `migrate` and `seed`. This Feature adds `db:generate` (wraps `drizzle-kit generate`) and `migrate:validate`. The quality manifest (FEAT-012) registers `migrate:validate` as the "migration validation" gate. Risk: a different name needs a one-line manifest edit.

- **`createPersistence` also exposes `ping()` and `close()`**: TBI-006 lists find, create, and update. FEAT-005 (readiness) and FEAT-007 (shutdown) need a database check and a pool close, and the single-importer rule means neither can touch the pool directly. Risk: low; both are one-line wrappers.

- **Forward-only migrations**: Drizzle Kit generates no down scripts, and the PRD rules out automatic down migrations. This differs from Apex, where each file has a `-- Down Migration` section. Local rollback uses `docker compose down -v` and a fresh `migrate`. Risk: developers used to Apex's `migrate:down` expect it.

- **Drizzle tooling behavior not verified at the pinned SHA**: The spec assumes (1) `drizzle-kit generate` accepts `--out`, `--schema`, and `--dialect`, so `migrate:validate` can generate into a scratch copy and fail if a file appears; (2) `drizzle-kit check` detects snapshot and journal inconsistency; (3) recent `drizzle-orm` versions wrap driver errors, so the error mapper reads the `cause` chain. The compatibility table pins the versions. Risk: a flag or wrapper differs, and S2, S5, or S7 adjust.

- **Generated JSON may fail Apex's formatting check**: Drizzle Kit writes `meta/_journal.json` and snapshot files in its own layout. The PRD already lists the formatting question as open for the whole template (see FEAT-001). Default used in this spec: `db:generate` runs Prettier on `apps/api/drizzle/meta/*.json` after generation, with no Apex change. I did not test whether Drizzle Kit's output already passes. Risk: the maintainers prefer an ignore entry.

- **PostgreSQL 13 or later**: `gen_random_uuid()` is built in from version 13, so the first migration needs no extension. The Compose image version (FEAT-002, TBI-005) must meet this. Risk: an older image makes the first migration fail.

- **Concurrent migration runs**: The command holds a PostgreSQL session advisory lock for the whole run, so two runs queue instead of racing. Risk: a stuck run blocks the next one; the lock frees when its connection closes.

- **Migration and application database roles**: The runbook advises a DDL-capable role for the migration command and a data-only role for the application. The template cannot enforce this, and Platform Engineering owns the roles. Risk: one shared role lets a compromised application change schema.

- **TLS to PostgreSQL**: The template contains no TLS code. Platform Engineering sets TLS options through the connection string or standard `PG*` variables. Apex hard-codes TLS in `src/server/db.ts`, and the template does not copy that. Risk: production connects without TLS if nobody sets it.

- **Integration test harness comes early**: TBI-024 (FEAT-011, phase 5) owns the Testcontainers setup, but this Feature's tests need it now. S4 adds a minimal `testDatabase` helper that creates a fresh database per test file, applies the committed migrations, and drops it on teardown. TBI-024 adopts and extends it. Risk: two helpers diverge if TBI-024 starts from scratch.

- **API boot test waits on FEAT-006**: PBI-003 (d) asks that the booting application leave the schema alone. The API composition root (FEAT-006, TBI-014) does not exist when this Feature ships. VT-17 proves the persistence module performs no schema change on an empty database. VT-18 repeats the check through the real boot path once TBI-014 lands. Risk: a gap between those two points.

- **"Pending migration" in the empty-database test**: With one initial migration, "a database missing a pending migration" means an empty database where the initial migration is pending. Risk: a later Feature with two or more migrations adds a partial-state case.

- **Name overlap with Apex's `app_users`**: Apex already has an `app_users` table (`oid` text primary key, RBAC identity cache) in `src/server/db/schema.ts`. The starter's table has a UUID primary key and a different purpose. The PRD fixes the name, and the template shares no database or code with Apex. The module map documents the overlap. Risk: an agent grounded in Apex confuses the two; the template's agent index must say they are unrelated.

- **Test tooling**: The tech spec template names Jest and Playwright. This Feature's Verification Test Matrix uses Vitest and Testcontainers because the PRD sets them for the template. Risk: none; the layer column names the tool.

- **Verification commands**: The tech spec template lists Apex's `tsc` commands. This spec lists the template's pnpm scripts and keeps one Apex command to show Apex still builds. Risk: none.

- **Migration SQL output carries no row values**: The commands print the SQLSTATE code and message of a database error and never its `detail`, `where`, or statement text, because those fields can hold row values (BR-007). Risk: a message names less than a developer wants; the runbook says to read the database log.

- **Telemetry capture of SQL**: FEAT-007 must leave `enhancedDatabaseReporting` off in the `pg` OpenTelemetry instrumentation, so spans hold parameterized SQL and no values. Risk: turning it on leaks identity values into traces.

- **Seed idempotence means insert-if-absent**: Re-running the seed never updates existing rows, so a seeded row a developer edited stays edited. Risk: a developer expects a reset; the runbook points to `docker compose down -v`.

- **Persona mapping**: Per the PRD, Platform Engineering maps to `Platform Admin`, template consumers and Apex-launched agents to `Developer`. No new personas. Risk: none beyond the PRD's own note.

- **Apex stays untouched**: No change to Apex `src/`, `migrations/`, `package.json`, or the root lockfile, per the existing-code protection rules and `scope-discipline.mdc`. Risk: none.
