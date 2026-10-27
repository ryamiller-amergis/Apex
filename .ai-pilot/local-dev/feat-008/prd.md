<!-- apex-grounded-sha:4d96cf6e677c8e4b9eb637bf944bc3677b12e8af -->

> Based on the **Apex** project, **main** branch, as of Oct 22, 2026.
---
title: Full-Stack Express Starter Template
slug: full-stack-express-starter-template
created: 2026-10-22
triage-status: needs-triage
glossary-terms-used:
  - Interview
  - PRD
  - Backlog
  - PBI
  - TBI
  - Skill
  - Feature Flag
  - RBAC
  - Platform Admin
---

# Full-Stack Express Starter Template

## Problem Statement

Teams that stand up ad hoc full-stack projects start from scratch each time. They choose tooling, wire a database, build an API, add a UI, and write their own agent instructions. The result varies from project to project and gives an agent building from a single prompt (the accepted single-prompt build orchestration ADR) no stable contract, quality manifest, or repository references to work from. Apex's own full-stack code is the nearest prior art, but it uses npm, Azure-focused infrastructure, and Apex-specific dependencies, so it cannot serve as a starting point for new projects.

## Solution

Apex will hold a self-contained sample template for review in an isolated folder (`templates/full-stack-express/`). The sample is a pnpm workspace with an Express 5 API, a React, Vite, and MUI web client, shared packages, Drizzle with PostgreSQL, working reference tests, a quality manifest, and an agent-readable knowledge base with five role skills. Its one reference feature is a self-service profile flow through `/api/v1/me`. Platform Engineering reviews the sample and, if accepted, moves it into its own bootstrap source. New projects then start from it in their own Azure DevOps repositories. The template does not change Apex's runtime, and it excludes AWS infrastructure, pipelines, migration execution, and repository governance, which Platform Engineering owns.

<!--
User stories are intentionally NOT authored here. They are owned by the SDLC backlog
({slug}.backlog.json) as PBI `userStory` objects, and the Apex PRD view renders them
read-only by projecting from the backlog at view time.
-->

## Implementation Decisions

**Isolation and delivery**

- The template is a nested, self-contained sample inside Apex. It has its own lockfile, dependencies, scripts, and lint rules, so Apex builds, tests, and checks are unaffected. It is not wired into Apex's root workspace or runtime.
- Delivery is a complete reference repository in an isolated folder, with documented placeholders for project name, package scope, service name, and database name. There is no generator or scaffolding command. Platform Engineering owns bootstrap automation.
- Tool versions come from the organization's approved stable set. They are pinned through Corepack and a committed lockfile with frozen installs, and recorded in a compatibility table.

**Workspace modules**

- Web application: React, Vite, MUI, React Router, TanStack Query, and React Hook Form. It builds to an independent artifact.
- API application: an Express 5 composition root that wires middleware, routes, identity, observability, and shutdown. It builds to an independent artifact.
- Contracts package (deep module): holds the Zod route definitions for every endpoint, including request, response, and error shapes. It derives TypeScript types and a generated OpenAPI 3.1 document from those definitions. It exposes one definition per route and a drift check that compares the generated document with the committed one.
- UI package (deep module): holds the neutral MUI design system. It provides semantic color, spacing, typography, and breakpoint tokens, light and dark themes, component defaults, the application shell, error boundary, and loading, empty, and error state components. Branding changes are token overrides only.
- Config package: shared TypeScript, lint, formatting, and test configuration for all workspace members.

**API contract (Zod is the single authority)**

- Zod schemas in shared route definitions are the source of truth. OpenAPI 3.1 is generated from them, committed, and checked for drift. A mismatch fails the check.
- Conventions: resource-oriented HTTP semantics, versioned routes, RFC 9457 Problem Details for every error, a request ID on every response, and documented pagination conventions for future list endpoints.
- Reference endpoints:
  - `GET /health/live` reports process liveness and requires no authentication.
  - `GET /health/ready` reports database readiness, requires no authentication, and exposes no sensitive detail.
  - `GET /api/v1/me` returns the authenticated principal's own profile.
  - `PUT /api/v1/me` validates input and updates the authenticated principal's own profile.
- There are no user list, user create, or user lookup endpoints. The identity provider owns identities, and no RBAC exists to authorize enumeration.

**Identity and access**

- An identity-provider adapter interface returns an authenticated-principal contract carrying at least the external identity subject. An authentication middleware uses the adapter and protects routes.
- The template defines no roles, permissions, or authorization policy. RBAC is an explicit extension point, and Platform Engineering will decide it later.
- The development adapter returns one fixed synthetic principal. It can be selected only when the authentication mode is `development` and the environment is not production. Production startup aborts if it is selected.

**Persistence**

- Drizzle with PostgreSQL. The starter table is `app_users` with a UUID primary key, a unique external identity subject, a display name, an optional email, a status, and created and updated timestamps. It holds no passwords, sessions, roles, audit events, or flag data.
- A data-access module (deep module) hides Drizzle behind a small interface for finding and updating a profile by external subject.
- The application repository owns Drizzle schema changes and reviewed SQL migration files, committed together. The application never changes schema at startup. Platform Engineering owns production execution of migrations as a separate deployment step. Production rollback uses forward corrective migrations.
- A seed command loads synthetic local data only.

**Configuration and local development**

- Environment variables are validated with Zod at startup. A missing or invalid required value aborts startup with a clear error. An example environment file lists every variable and contains no secrets. Production secrets reach the application only through environment variables.
- Local development uses Node and pnpm on the host, with PostgreSQL in Docker Compose. Stable, named scripts cover install, build, check, test, migrate, seed, and run. Platform Engineering's pipeline will call these scripts. The template ships no pipeline definition.

**Observability**

- Structured JSON logs through Pino, with request and correlation IDs and redaction hooks for identity fields. OpenTelemetry traces and metrics are configured by environment so Platform Engineering can attach CloudWatch or ADOT exporters without code changes. The API drains in-flight requests and closes database connections on shutdown. Logs, telemetry, and API errors never contain identity values.

**Feature flag interface**

- A provider-neutral flag-evaluation interface with a local, configuration-driven adapter. It adds no vendor SDK. Projects replace the adapter once a provider is chosen. This is a capability of generated applications, separate from Apex's own Feature Flag system.

**Quality and supply chain**

- A machine-readable quality manifest lists each gate (build, type-check, lint, formatting, OpenAPI drift, migration validation, unit, component, API, integration, accessibility, and container build) and the script that runs it. It records coverage floors of 80% for lines, functions, and statements and 75% for branches, and justified deferrals. It defines no execution tiers or schedule.
- A required NFR manifest schema, a validator, and load-test tooling are included. Each project supplies its own response-time, concurrency, and data-volume targets. Illustrative values show the format only and are not promises. Each consuming team decides when load tests run.
- The supply-chain baseline covers pinned tools, secret scanning, vulnerability scanning, license checks, and SBOM generation, each exposed as a script.
- One production container definition is multi-stage, runs as a non-root user, has a minimal runtime surface, and packages the API and the built web client. It makes no AWS or ECS assumptions. Platform Engineering owns ECS, AWS infrastructure, and pipelines.

**Agent guidance and knowledge base**

- Docs-as-code with no runtime wiki service. The pieces are an agent entry-point document, architecture documentation, an ADR area, module maps, API documentation, runbooks, testing guidance, a design-system reference, a component catalog, the compatibility table, and a plain-text index for agents. A validation script checks links, required sections, and stale paths.
- Two enforceable skills: `api-contract` (Zod and OpenAPI rules, HTTP semantics, errors, pagination, auth boundaries, contract tests) and `ui-standards` (theme usage, component rules, responsive states, accessibility, forms, query handling, test selectors).
- Five role skills: planner, UI, developer, QA, and integration. The developer skill requires `api-contract` and `ui-standards` when relevant. The QA and integration skills consume the quality manifest. Skills point to immutable project references. The generated application has no AI runtime, model dependency, or SSE.

**Handoff**

- A handoff document lists what the template provides, what Platform Engineering owns, the contracts Platform Engineering consumes (scripts, manifests, health endpoints, environment variables, the migration command), and a register of unresolved decisions with the extension point each one affects.

## Testing Decisions

- **What makes a good test here:** Tests prove observable behavior. For the API, that means status codes, Problem Details bodies, response shapes, and persisted data. For the web client, it means what a person sees and can do, and for the checks, it means exit status and reported findings. They do not assert internal wiring or library calls.
- **Modules to test:**
  - Contracts package (deep module) — generated OpenAPI must match the committed document, and responses must conform to it.
  - Data-access module (deep module) — find, create-on-first-access, and update against real PostgreSQL through containers, including constraint violations.
  - Identity adapter and authentication middleware — unauthenticated requests are rejected, the development adapter works only under its guard, and production startup aborts when it is selected.
  - Configuration validation — missing, malformed, and valid environment values.
  - Profile API — success, validation failure, and database failure, and a principal can never reach another principal's data.
  - Health endpoints — liveness without dependencies, readiness with and without the database.
  - Web client profile flow — view, edit, validation, error and loading states, query invalidation, and keyboard and screen-reader use.
  - Quality manifest, NFR manifest, and documentation validators — pass on valid input and fail with a clear message on invalid input.
  - Migration validation — migrations apply cleanly to an empty database and the schema matches the Drizzle definitions.
- **Reference test layers:** unit and component tests, API tests, PostgreSQL integration tests, Playwright journeys with axe accessibility checks, and contract tests. The framework and working reference tests are included. When CI runs them, and which tiers are required, is left for each consuming team to define.
- **Prior art:** Apex layers Jest unit and integration tests, Supertest API tests, and Playwright end-to-end tests with accessibility checks, and it enforces data-testid conventions. The template uses the same layering with Vitest, React Testing Library, Testcontainers, and Playwright with axe.

## Target Surface

- **Primary surface:** Full-stack (both client and server)
- **Experience notes:** The template is a standalone starter repository, not an Apex screen. Its reference experience is a self-service profile screen backed by the profile API, shown in a responsive, accessible application shell with light and dark themes. It has no Apex navigation entry.

---

## Access Control and Permissions

| Action | Required group(s) / role(s) | Data scope |
|--------|---------------------------|-----------|
| Read own profile (`GET /api/v1/me`) | Authenticated principal from the identity-provider adapter; no roles defined | User-scoped |
| Update own profile (`PUT /api/v1/me`) | Authenticated principal from the identity-provider adapter; no roles defined | User-scoped |
| Check liveness and readiness (`/health/live`, `/health/ready`) | None | No restriction |
| Use the development identity adapter | Local only: authentication mode `development` and non-production environment | User-scoped (one fixed synthetic principal) |
| Review the template in Apex and move it to the bootstrap source | Platform Engineering (mapped to `Platform Admin` in the backlog) | Global |
| Role-based authorization in generated apps | Not defined; an extension point for Platform Engineering | Not applicable |

---

## Security and Data Sensitivity

- **Sensitive fields:** The example `app_users` record holds a display name, an optional email, and an external identity subject. Their data classification is unresolved and is left to Platform Engineering. The template applies synthetic fixtures and identity redaction as engineering practice only, not as a classification.
- **Handling requirements:** Mask identity fields in logs and telemetry. Keep identity values out of API error bodies. Use synthetic values only in seeds, fixtures, and tests. Supply production secrets only through environment variables. The development identity adapter must never run in production. Supply-chain scanning covers secrets, vulnerabilities, and licenses.
- **Data scope enforcement:** The profile endpoints take the external subject from the authenticated principal and never from request input. No endpoint lists or looks up other people's records. Data is scoped to the generated application instance, and the template has no cross-project data.

---

## Non-Functional Requirements

- **Response time:** Not specified. Each generated project supplies its own targets through the required NFR manifest. Illustrative values such as P95 under 500 ms at 50 concurrent users show the format only and are not production promises.
- **Concurrency:** Not specified. Each project supplies its target through the NFR manifest. Load-test tooling is included, with no execution policy.
- **Data volume:** Not specified. Each project supplies its target through the NFR manifest. An illustrative value of 100,000 user rows shows the format only. API conventions require bounded pagination for any future list endpoint.

---

## Feature Flag

> **Authoritative for backlog `featureFlag`.** If **Flag required: No**, the backlog must **not** include a `featureFlag` property on any Feature. If **Flag required: Yes**, every affected Feature in the backlog must include `featureFlag.name` matching this section.

- **Flag required:** No
- **Flag name:** None
- **Rollout sequence:** Not applicable (a reviewable sample that does not change Apex runtime behavior)
- **Kill switch owner:** Not applicable
- **Behavior when disabled:** Not applicable

The template's own provider-neutral feature-flag interface and local adapter are a deliverable for generated applications. They are not an Apex Feature Flag for this work.

---

## Out of Scope

- AWS infrastructure as code and Terraform, ECS configuration, and any deployment automation (Platform Engineering).
- CI/CD pipeline definitions, image publishing, and deployment stages (Platform Engineering). The template exposes scripts and manifests only.
- Bootstrap or provisioning automation, a generator or scaffolding command, and any Apex integration with Azure DevOps repository creation.
- Any change to Apex runtime behavior, its database, or its services.
- Repository governance files such as contribution guides, code owners, pull-request templates, changelog policy, and commit conventions (Platform Engineering).
- A production identity provider, roles, permissions, and RBAC.
- Data classification of the example user fields (Platform Engineering).
- Fixed performance targets, load-test execution policy, and the required CI tiers.
- Production execution of database migrations (Platform Engineering).
- User list, user create, user lookup, or full user CRUD endpoints.
- Runtime AI or LLM services, model dependencies, SSE, and a runtime searchable wiki.
- A feature-flag provider or hosted flag service.
- Apex-specific code, Apex RBAC and groups, and Amergis branding.

## Assumptions Made

- The accepted ADR "Build from prompt (single-prompt-build-orchestration)" is cited in the transcript, but its text was not available in the repository checkout. The five-role skill set, quality manifest, and immutable project references follow the transcript's summary of it and should be confirmed against the ADR.
- Platform Engineering is not an Apex persona. Backlog stories map it to `Platform Admin`, the closest cross-project administrator persona. Template consumers and Apex-launched development agents map to `Developer`. People who use the sample profile screen map to `Authenticated User`. No new personas are introduced.
- `GET /api/v1/me` creates the `app_users` row on first authenticated access from the principal's subject and display name. The identity provider owns identities and the sample has no create endpoint, so this is the only way a profile can come to exist. Confirm this behavior.
- The production container packages the API and the built web client, and Express serves the built client from the same process. The template still produces independent web and API build artifacts, as the transcript requires.
- Apex's root formatting check scans the whole repository. The template must conform to Apex's existing formatting rules, or the maintainers must approve a minimal ignore entry. Confirm which approach to use.
- The transcript does not name the tools for OpenAPI generation, load testing, secret and vulnerability scanning, license checks, or SBOM generation. Implementation selects them from the organization-approved set and records them in the compatibility table.
- Automated dependency-update configuration is left to Platform Engineering with the pipeline and repository governance, because the transcript assigned both to them.
- The set of `status` values on `app_users` is not specified. Implementation chooses a small documented set.
- Example NFR values (P95 under 500 ms at 50 concurrent users, 100,000 user rows) illustrate the manifest format only. They are not requirements or promises.
- Unresolved decisions that the template leaves as extension points are: production identity provider, RBAC, data classification, NFR targets and test execution policy, and feature-flag provider.
