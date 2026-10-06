---
name: Product Implementation
description: >-
  Implements exactly one approved build from docs/product/BUILD_BRIEF.md and
  docs/product/build-manifest.json. Defaults to React, TypeScript, Vite,
  Express, and PostgreSQL. Uses test-first development, leaves a deployable
  project, and does not commit, push, or open the pull request. Use when the
  cloud runner starts an approved product build.
---

# Product Implementation

You implement the approved build. You do not widen it.

## Read first

1. `docs/product/build-manifest.json` is the source of truth for the slice.
2. `docs/product/BUILD_BRIEF.md` is that same slice in prose.
3. `PRODUCT.md` is product context only. Do not implement work that appears only there.

If the brief and the manifest disagree, stop and report the mismatch. Do not invent a third scope.

## Scope

Implement `initialBuild`, the stack, and the deployment notes. Honor `outOfScope` and `deferred`. This is one pull request. If the work does not fit, stop and say what must be cut. Do not start a second change.

**When application code is already on main.** Add this slice to that application. Keep the existing client, server, migrations, tests, scripts, and CI. Do not scaffold a second app. New behavior still needs a test named for each acceptance criterion, and the quality gate must pass for the whole application.

## Stack

Use React + TypeScript + Vite, Express, and PostgreSQL unless the manifest sets `stack.overrideReason`. Include:

- Local setup a reviewer can run
- Tests
- Database migrations
- CI checks
- Deployment configuration

A hosted preview of the running app is out of scope.

## Layout

Use this shape unless the manifest gives a reason not to:

- `client/` — React + TypeScript + Vite workspace
- `server/` — Express + TypeScript workspace
- Root `package.json` with npm workspaces for `client` and `server`. The root scripts call the same script in each workspace.
- `migrations/` — node-pg-migrate
- `docker-compose.yml` and `.env.example` for local PostgreSQL
- `e2e/` — Playwright for the workflow and for accessibility
- `.github/workflows/ci.yml` — the same commands listed under Quality gate
- `docs/DEPLOYMENT.md` — how to run it locally. Not a hosted preview.

Name tests after the acceptance criterion ids, such as `ac-1`. Cover each id on the server and, when the screen is part of the criterion, on the client.

## Tests

Work test-first. For each acceptance criterion id in the manifest, write a failing test that names that id, then the code that makes it pass. Do not add behavior that has no criterion.

## Scripts

This is a Node repository. The root `package.json` must define these scripts:

- `lint`
- `typecheck`
- `test`
- `build`
- `migrate:check` — checks that migrations are valid and does not apply them or change the database
- `test:e2e`
- `test:a11y`

## Quality gate

Before you finish, run these from the repository root and fix every failure:

1. `npm ci` when `package-lock.json` exists, otherwise `npm install`
2. `npm run lint`
3. `npm run typecheck`
4. `npm run test`
5. `npm run build`
6. `npm run migrate:check`
7. `npm run test:e2e`
8. `npm run test:a11y`
9. `npm audit --omit=dev --audit-level=high`

The runner runs that same list. It commits, pushes, and opens the pull request only when every command passes. A missing script counts as a failure. Do not finish while a required check fails. Do not commit, push, or open the pull request yourself.

## Finish

Leave the tree ready for the cloud runner. Do not commit, push, or create the pull request. The runner does that.

In the final message, list:

- Each acceptance criterion and the test that covers it
- How to run setup, tests, migrations, and the CI checks locally
- Limits copied from the brief, including deferred and out-of-scope items

## Do not

- Do not treat `PRODUCT.md` as a backlog.
- Do not add screens, integrations, or roles the brief does not list.
- Do not commit, push, or open a pull request.
- Do not copy this skill into Apex's own skill folders. It is seeded from `new-project-skills/`.
