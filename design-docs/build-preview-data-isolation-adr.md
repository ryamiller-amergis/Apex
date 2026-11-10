---
adr-number: ADR-pending
status: Accepted
date: 2026-11-05
slug: build-preview-data-isolation
approved-by: Phase 2 product owner
approval-source: Cursor session approval on 2026-11-05
---

# Build Preview Data Isolation

## Status

Accepted for the Phase 2 pilot.

## Context

A live preview must prove the generated application's real PostgreSQL and Drizzle behavior, including migrations, synthetic seed data, reads, writes, and persistence after reload. It must never connect to a production database or clone production data.

The Golden Stack production image deliberately removes migration and seed assets. Its current seed command also refuses `NODE_ENV=production`. The preview therefore cannot run migration and seed logic inside the long-lived web process without changing the runtime contract.

The pilot needs fast provisioning and strong per-revision cleanup without creating a PostgreSQL server for every preview.

## Decision Drivers

- Exercise the same database engine and application paths used in production.
- Isolate credentials and data between revisions.
- Keep startup within the preview readiness SLO.
- Make cleanup deterministic and independently retryable.
- Use synthetic data only.

## Considered Options

### PostgreSQL inside each sandbox

This provides strong compute-level isolation but increases image size, startup time, memory use, persistence complexity, and cleanup work. Retained as the local Docker implementation, not the Azure pilot default.

### One schema per preview on a shared database

Schema isolation is weaker, connection URLs are less self-contained, and migration assumptions may break. Rejected.

### One database and role per preview on a shared preview-only server

Each instance gets a randomly named database and login role on a regional preview-only PostgreSQL server. A separate job migrates and seeds it. Chosen for the Azure pilot.

### One PostgreSQL server per preview

This provides stronger infrastructure isolation but cannot meet pilot startup and cost targets. Retained only as a future dedicated tier.

## Decision Outcome

Chosen option: **one database and login role per preview instance on a shared, preview-only PostgreSQL Flexible Server**.

Lifecycle:

1. Create a random database, a `NOLOGIN` owner role, a short-lived migration login, and a separate short-lived application login.
2. Revoke `CONNECT` and `TEMPORARY` on the database from `PUBLIC`; grant only the required access to the migration and application roles.
3. Revoke `CREATE` and `USAGE` on the `public` schema from `PUBLIC`. The owner controls schema changes; the application role receives only the table, sequence, and function privileges required at runtime.
4. Deny database creation, role management, replication, bypass-RLS, and broad administrative privileges. Set connection limits and `VALID UNTIL` no later than the preview expiry.
5. Deliver the short-lived credentials through the authenticated sandbox bootstrap channel. Never store revision credentials in pool-wide environment variables.
6. Run migrations from a separate migration artifact/job using the migration role, then revoke or disable that login.
7. Run a dedicated `preview-seed` command with deterministic synthetic data. It is distinct from production seeding and may execute while the application itself runs in production mode.
8. Start the application with a maximum pool size of five connections.
9. Record migration and seed checksums against the preview instance.
10. On acceptance, cancellation, expiry, failure, or supersession: revoke both logins, terminate every database session, drop the database, drop all three roles, and delete credentials.
11. Keep cleanup in durable state until every resource is confirmed absent; alert on orphans older than 10 minutes.

State does not carry automatically from revision N to revision N+1. A later snapshot feature may copy synthetic data only after explicit classification, size, and retention controls.

Pilot conditions:

- Database creation, migration, deterministic seed, application startup, and readiness must fit the 90-second readiness P95 target.
- Database and role teardown is measured against the separate 10-minute cleanup objective, not the readiness target.
- Concurrent previews must not access another revision's database or credential.
- Connection and storage quotas must prevent one preview from degrading others.
- Region and private network connectivity must be verified before the Azure pilot.

## Consequences

### Positive

- The browser journey proves real PostgreSQL-backed behavior.
- Each revision has a distinct credential and database namespace.
- Provisioning is faster and cheaper than one server per revision.
- Migration and seed failures prevent route publication.

### Negative

- The shared server remains a noisy-neighbor and infrastructure trust boundary.
- Database creation/drop throughput and connection limits must be measured.
- The Golden Stack needs a preview migration artifact and a dedicated preview-seed contract.
- High-sensitivity projects may require a dedicated database server later.

## References

- `templates/full-stack-express/Dockerfile`
- `templates/full-stack-express/apps/api/src/cli/seed.ts`
- `templates/full-stack-express/apps/api/src/cli/migrate.ts`
- `templates/full-stack-express/apps/api/src/persistence/seed/seedUsers.ts`
- `design-docs/build-from-prompt-phase-2.plan.md`
- https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-servers
