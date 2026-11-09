# 0003: Production schema rollback is a new corrective migration

- Status: Accepted
- Date: 2026-10-27
- Deciders: template maintainers, Platform Engineering

## Context and Problem Statement

Schema changes must be repeatable, reviewable, and safe while the previous release still serves traffic. Down migrations are rarely tested, can destroy data, and Drizzle Kit does not generate them. How does a team undo a production schema change?

## Considered Options

- Forward-only: undo a change by shipping a new corrective migration
- Paired up and down migrations for every change
- Let the application change the schema when it starts

## Decision Outcome

Chosen option: "Forward-only", because every change, including an undo, then goes through the same generate, review, validate, and apply path.

The application never changes the schema when it starts. `pnpm migrate` applies pending SQL files from `apps/api/drizzle/`, and Platform Engineering runs it in every shared environment before traffic switches. Every change stays backward compatible with the release still serving traffic: expand first, contract in a later release. The [migrations runbook](../runbooks/migrations.md) has the workflow.

### Consequences

- Good: one tested path for every schema change.
- Good: starting the application cannot alter or lock the schema.
- Bad: undoing a change takes a new migration and a release, not a single command.
- Bad: a destructive change needs two releases, one to expand and one to contract.
