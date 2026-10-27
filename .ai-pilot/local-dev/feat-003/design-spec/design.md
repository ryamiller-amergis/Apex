# Design — Starter Persistence with app_users

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Data and API Contract Layer | **Affected personas:** Developer, Platform Admin
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (5 unresolved)

---

## Feature Summary

**Description:** Every full-stack project that starts from the template needs a database, a schema change process, and sample data, and today each team invents them. This Feature gives the template Drizzle and PostgreSQL with one example table, `app_users`, reviewed SQL migrations that ship in the same pull request as the schema change, and a seed command for synthetic local data. Developers change the data model without waiting on another team. Platform Admin (standing in for Platform Engineering) gets one standalone command to run migrations before traffic switches. The application never changes the schema when it starts.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-006 | TBI | Define the app_users schema and data-access module | Must Have |
| TBI-007 | TBI | Add the reviewed SQL migration workflow and standalone migration command | Must Have |
| TBI-008 | TBI | Add the synthetic seed command | Should Have |
| PBI-003 | PBI | Change the data model with a reviewed migration | Must Have |
| PBI-004 | PBI | Run migrations as a separate deployment step | Must Have |
| PBI-005 | PBI | Load synthetic seed data locally | Should Have |

---

## Scope and Out-of-Scope

**In scope:**
- The `app_users` table: UUID primary key, unique external identity subject, display name, optional email, status, created and updated timestamps (TBI-006).
- A data-access module that hides Drizzle behind three operations: find, create, and update a profile by external subject. It is the only code that imports the Drizzle client for application queries (TBI-006).
- Typed errors for constraint violations, an unmigrated database, and an unreachable database, so no raw database error leaves the module (TBI-006).
- Generated, committed SQL migrations, with the initial migration that creates `app_users` (TBI-007, PBI-003).
- A validation script that fails when the Drizzle schema and the committed migrations disagree and names the difference (TBI-007, PBI-003).
- A standalone migration command that runs apart from the application process, is safe to re-run, and exits non-zero on failure (TBI-007, PBI-004).
- A runbook that states who owns migration files, who runs them, and that production rollback is forward-only (TBI-007, PBI-003, PBI-004).
- A seed command that inserts clearly synthetic rows, is safe to re-run, and refuses to run in production (TBI-008, PBI-005).

**Out of scope:**
- Roles, permissions, sessions, audit events, and feature-flag tables (Feature, Epic, and PRD).
- Passwords or any credential column on `app_users`.
- Destructive down migrations in production, and automatic down migrations of any kind (Feature, PBI-003).
- Running migrations in production; Platform Engineering owns execution (Epic, PBI-003, PRD).
- ECS task definitions and pipeline stages that call the migration command (PBI-004).
- Bulk data generation for load tests, and seeding shared environments (PBI-005).
- User list, user create, user lookup, or full user CRUD endpoints (PRD). The profile routes belong to the Health and Self-Service Profile API Feature.
- Data classification of the example user fields (PRD; Platform Engineering).
- A production identity provider, roles, and RBAC (PRD).
- Any change to Apex runtime behavior, its database, or its services (PRD). The starter's `app_users` is a separate table in a separate database from Apex's own `app_users`.

---

## Target Surface

**Primary surface:** Backend only for this Feature (Express API workspace member of the template, plus a PostgreSQL schema, SQL migration files, and command-line scripts). The PRD sets the template as a whole to Full-stack; this Feature has no client surface.

**Experience notes:** The people who use this Feature are Developers and Platform Admin, and they use it from a terminal. There is no Apex screen, no navigation entry, and no web client change. Command-line messages are the user experience, so they are specified here.

| Command | Situation | Message (wording to implement) | Exit status |
|---------|-----------|--------------------------------|-------------|
| `pnpm migrate` | Pending migrations applied | `Applied 1 migration: 0000_init_app_users` (lists each tag) | 0 |
| `pnpm migrate` | Nothing pending | `No pending migrations.` | 0 |
| `pnpm migrate` | A migration fails | `Migration 0001_add_phone failed: 42703 column "x" does not exist` (SQLSTATE code and message only) | 1 |
| `pnpm migrate` | `DATABASE_URL` missing | `Configuration error: DATABASE_URL is missing.` | 2 |
| `pnpm migrate` | `DATABASE_URL` malformed | `Configuration error: DATABASE_URL is not a valid PostgreSQL connection URL.` (the value never appears) | 2 |
| `pnpm migrate:validate` | Schema and migrations agree | `Migrations match the Drizzle schema.` | 0 |
| `pnpm migrate:validate` | Schema changed with no migration | `Schema differs from committed migrations. Run "pnpm db:generate" and commit the result.` followed by the SQL that the missing migration would contain | 1 |
| `pnpm seed` | Seed applied | `Seeded 3 new rows; 0 already present.` | 0 |
| `pnpm seed` | Seed run again | `Seeded 0 new rows; 3 already present.` | 0 |
| `pnpm seed` | No migrations applied | `The app_users table does not exist. Run "pnpm migrate" first.` | 1 |
| `pnpm seed` | Environment is production | `Refusing to seed: NODE_ENV is production. Seeding never runs in production.` | 1 |

No message prints a connection URL, a password, a display name, an email, or an external subject.

---

## Access Control

The template defines no roles, permissions, or authorization policy, and this Feature adds none. Access to the database comes from the database credential in the environment, not from an Apex permission.

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Read own profile through `GET /api/v1/me` (uses this Feature's data-access module) | Authenticated principal from the identity-provider adapter; no roles defined | User-scoped |
| Update own profile through `PUT /api/v1/me` (uses this Feature's data-access module) | Authenticated principal from the identity-provider adapter; no roles defined | User-scoped |
| Run the standalone migration command | Platform Admin (stands in for Platform Engineering) with a database credential that can change schema | Global (whole database schema) |
| Generate a migration and run migration validation | Developer, on a local checkout | No restriction (local files only) |
| Run the seed command | Developer, local database only; refused when `NODE_ENV` is `production` | No restriction (local database only) |
| Review the template in Apex and move it to the bootstrap source | Platform Admin | Global |
| Role-based authorization in generated apps | Not defined; an extension point for Platform Engineering | Not applicable |

**Data scope rule for the data-access module:** every operation takes the external subject as an argument and touches at most one row. The module offers no list, no search, and no lookup by UUID.

**Feature flag:** `None` — rollout: None (a reviewable sample that does not change Apex runtime behavior)
**Behavior when flag is off:** Not applicable

---

## Acceptance Criteria

### PBI-003 — Change the data model with a reviewed migration

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I add a column to the Drizzle schema | I generate the migration and run the migration validation | A SQL migration file is created and validation confirms schema and migrations agree |
| (b) Error/failure | I changed the schema but did not generate a migration | I run the migration validation | Validation fails and names the schema difference |
| (c) Edge case/boundary | The database is empty | I apply all committed migrations | They apply in order without error and produce the current schema |
| (d) Negative scenario | The API starts against a database that is missing a pending migration | The application boots | It does not alter the schema or apply the migration |

### PBI-004 — Run migrations as a separate deployment step

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A database with pending migrations and a valid connection in the environment | I run the standalone migration command | Pending migrations apply in order and the command exits with status zero |
| (b) Error/failure | A migration contains an error | I run the migration command | The command exits non-zero, reports the failing migration, and does not report success |
| (c) Edge case/boundary | All migrations are already applied | I run the migration command again | Nothing changes and the command exits with status zero |
| (d) Negative scenario | The database connection value is missing | I run the migration command | The command aborts before connecting and names the missing variable without printing secrets |

### PBI-005 — Load synthetic seed data locally

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | My local database has the current schema | I run the seed command | Synthetic `app_users` rows exist |
| (b) Error/failure | My local database has no migrations applied | I run the seed command | The command fails with a message telling me to run migrations first |
| (c) Edge case/boundary | I already ran the seed | I run it again | No duplicate rows are created and no error occurs |
| (d) Negative scenario | The environment is set to production | I run the seed command | The command refuses to run and changes no data |

### Technical backlog items — definition of done

Each TBI is done when every line below passes. The Verification Test Matrix in [design-doc-tech-spec.md](design-doc-tech-spec.md) names the test for each line.

**TBI-006 — Define the app_users schema and data-access module**
- The schema defines the listed columns with a unique constraint on the external identity subject.
- The data-access module exposes find, create, and update by external subject.
- Integration tests against real PostgreSQL cover create, find, update, and unique-constraint failure.
- No other table is defined.
- Only the data-access module imports the Drizzle client for application queries.
- Constraint violations surface as typed errors, not raw database errors.

**TBI-007 — Add the reviewed SQL migration workflow and standalone migration command**
- The initial migration creates `app_users` and is committed.
- The migration command runs standalone and exits non-zero on failure.
- Application startup contains no schema-changing code.
- A validation script confirms the committed migrations match the Drizzle schema.
- Documentation states that the application repository owns migration files, Platform Engineering owns execution, and production rollback is forward-only.
- Migrations can run again once applied without error.

**TBI-008 — Add the synthetic seed command**
- The seed command inserts clearly synthetic rows.
- Running the seed twice leaves the same rows.
- The seed refuses to run when the environment is production.
- A test confirms seed values use synthetic domains and names.

---

## UI/UX

Not applicable. This Feature changes no screen, route, component, or client hook. The only user-facing text is the command-line output listed under Target Surface, and it has no `data-testid` attributes or accessibility behavior beyond plain-text output that a screen reader or an agent can read.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
