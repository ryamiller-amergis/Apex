# Platform Engineering handoff

Read this document once when deciding whether to adopt the Full-Stack Express
starter template into the bootstrap source. It lists what the template ships,
what Platform Engineering owns, which scripts and files a pipeline should call,
which placeholders a new project replaces, and which production decisions remain
open.

## What the Template Provides

- A self-contained pnpm workspace with Express 5 API, React web client, shared
  contracts, UI design system, and configuration packages.
- Documented root scripts for install, build, check, test, local run, migrate,
  seed, documentation validation, supply-chain scans, SBOM generation, and
  production image build.
- Machine-readable quality and NFR manifests, a committed OpenAPI 3.1 document,
  reference tests, role skills, and a multi-stage production container
  definition.
- An orchestrator skill that writes a brief and a plan, asks the recorded
  questions, and shows the integration verdict after QA.

## Ownership

| Area                                                          | Owner                | What the template ships                            | What Platform Engineering does                                       |
| ------------------------------------------------------------- | -------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| AWS infrastructure                                            | Platform Engineering | No Terraform, ECS, or cloud modules                | Provisions AWS infrastructure and ECS for generated projects         |
| CI/CD pipelines                                               | Platform Engineering | Root scripts and manifests only                    | Defines pipeline stages, image publishing, and deployment automation |
| Migration execution                                           | Platform Engineering | Reviewed SQL migrations and `pnpm migrate`         | Runs migrations as a separate deployment step before traffic         |
| Deployment packaging — container definition                   | Template             | `Dockerfile` and `pnpm container:build`            | Consumes the image definition in its registry and runtime            |
| Deployment packaging — image publishing and deployment stages | Platform Engineering | No publish or deploy scripts                       | Publishes images and promotes deployment stages                      |
| Repository governance                                         | Platform Engineering | No contribution guide, CODEOWNERS, or PR templates | Adds governance files per organization policy                        |

## Contracts Platform Engineering Consumes

| Kind      | Identifier                              | Purpose                                                 | Source in the template    |
| --------- | --------------------------------------- | ------------------------------------------------------- | ------------------------- |
| script    | setup                                   | Frozen install from the lockfile                        | Root `package.json`       |
| script    | build                                   | Build every workspace member                            | Root `package.json`       |
| script    | check                                   | Typecheck, lint, format, OpenAPI drift, routes          | Root `package.json`       |
| script    | test                                    | Run unit, component, API, contract, and optional suites | Root `package.json`       |
| script    | dev                                     | Run API and web client locally                          | Root `package.json`       |
| script    | migrate                                 | Apply pending SQL migrations                            | Root `package.json`       |
| script    | seed                                    | Load synthetic local data                               | Root `package.json`       |
| script    | docs:check                              | Validate documentation and handoff contracts            | Root `package.json`       |
| script    | quality:validate                        | Validate quality and NFR manifests                      | Root `package.json`       |
| script    | scan:secrets                            | Secret scan over tracked files                          | Root `package.json`       |
| script    | scan:vulns                              | Vulnerability scan of the lockfile                      | Root `package.json`       |
| script    | scan:licenses                           | Production license allow-list check                     | Root `package.json`       |
| script    | sbom                                    | Write a CycloneDX SBOM                                  | Root `package.json`       |
| script    | container:build                         | Build the production image                              | Root `package.json`       |
| manifest  | quality/quality-manifest.json           | Quality gate ids and scripts                            | Committed manifest        |
| manifest  | quality/nfr-manifest.json               | Response-time, concurrency, volume targets              | Committed manifest        |
| manifest  | docs/compatibility.md                   | Pinned toolchain and dependency versions                | Committed table           |
| manifest  | packages/contracts/openapi/openapi.json | Generated OpenAPI 3.1 document                          | Committed contract output |
| endpoint  | GET /health/live                        | Process liveness probe                                  | OpenAPI paths             |
| endpoint  | GET /health/ready                       | Database readiness probe                                | OpenAPI paths             |
| endpoint  | GET /api/v1/me                          | Read own profile                                        | OpenAPI paths             |
| endpoint  | PUT /api/v1/me                          | Update own profile                                      | OpenAPI paths             |
| env       | NODE_ENV                                | Runtime environment name                                | `.env.example`            |
| env       | PORT                                    | API listen port                                         | `.env.example`            |
| env       | LOG_LEVEL                               | Minimum log level                                       | `.env.example`            |
| env       | DATABASE_URL                            | PostgreSQL connection string                            | `.env.example`            |
| env       | AUTH_MODE                               | Identity adapter selection                              | `.env.example`            |
| env       | FEATURE_FLAGS                           | Optional local flag map                                 | `.env.example`            |
| env       | SHUTDOWN_TIMEOUT_MS                     | Graceful shutdown budget                                | `.env.example`            |
| env       | READINESS_TIMEOUT_MS                    | Readiness probe timeout                                 | `.env.example`            |
| env       | RATE_LIMIT_MAX                          | Optional API rate limit                                 | `.env.example`            |
| env       | RATE_LIMIT_WINDOW_MS                    | Rate limit window                                       | `.env.example`            |
| env       | CLIENT_DIST_DIR                         | Built web client static root                            | `.env.example`            |
| env       | OTEL_SDK_DISABLED                       | Disable OpenTelemetry                                   | `.env.example`            |
| env       | OTEL_SERVICE_NAME                       | Telemetry service name                                  | `.env.example`            |
| env       | OTEL_EXPORTER_OTLP_ENDPOINT             | OTLP collector base URL                                 | `.env.example`            |
| env       | OTEL_EXPORTER_OTLP_TRACES_ENDPOINT      | OTLP traces endpoint                                    | `.env.example`            |
| env       | OTEL_EXPORTER_OTLP_METRICS_ENDPOINT     | OTLP metrics endpoint                                   | `.env.example`            |
| env       | OTEL_EXPORTER_OTLP_PROTOCOL             | OTLP protocol                                           | `.env.example`            |
| env       | OTEL_EXPORTER_OTLP_HEADERS              | OTLP headers                                            | `.env.example`            |
| env       | OTEL_EXPORTER_OTLP_TIMEOUT              | OTLP export timeout                                     | `.env.example`            |
| env       | OTEL_TRACES_EXPORTER                    | Trace exporter selection                                | `.env.example`            |
| env       | OTEL_METRICS_EXPORTER                   | Metrics exporter selection                              | `.env.example`            |
| env       | OTEL_METRIC_EXPORT_INTERVAL             | Metrics export interval                                 | `.env.example`            |
| env       | OTEL_BSP_SCHEDULE_DELAY                 | Batch span processor delay                              | `.env.example`            |
| env       | VITE_APP_NAME                           | Web display name                                        | `.env.example`            |
| env       | VITE_API_BASE_URL                       | Web API base URL                                        | `.env.example`            |
| env       | POSTGRES_USER                           | Compose database user                                   | `.env.example`            |
| env       | POSTGRES_PASSWORD                       | Compose database password                               | `.env.example`            |
| env       | POSTGRES_DB                             | Compose database name                                   | `.env.example`            |
| env       | POSTGRES_PORT                           | Compose published port                                  | `.env.example`            |
| container | Dockerfile                              | Multi-stage production image                            | Repository root           |

## Replacement Placeholders

| Placeholder     | Meaning                                   | Where it appears                                       |
| --------------- | ----------------------------------------- | ------------------------------------------------------ |
| project-name    | Human-readable product name               | Root `package.json` description, README, OpenAPI title |
| @project-scope  | npm scope for every workspace package     | All `package.json` names and workspace imports         |
| project-service | Service name for observability and images | README, `.env.example`, container tag                  |
| project_db      | Local PostgreSQL database name            | README, `compose.yaml`, `.env.example`                 |

## Unresolved Decision Register

| Decision                              | Extension point                                                                                      | Template behavior until decided                                                                                                                                                                                         | Decision needed from Platform Engineering                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Production identity provider          | `apps/api/src/identity/adapter.ts`, `apps/api/src/identity/authMiddleware.ts`                        | `AUTH_MODE=development` uses one synthetic principal; production must not select it                                                                                                                                     | Choose and wire the production IdP adapter                  |
| RBAC                                  | `apps/api/src/identity/authMiddleware.ts`, `packages/contracts/src/index.ts`                         | Authentication only; no roles or permissions                                                                                                                                                                            | Define authorization policy and enforce it at routes        |
| Data classification                   | `apps/api/src/persistence/schema.ts`, `apps/api/src/observability/redaction.ts`                      | Display name, email, and external subject are example fields; classification of those fields is unresolved. Synthetic fixtures and identity redaction in logs are engineering practice, not a data classification level | Assign data classification and handling rules               |
| NFR targets and test execution policy | `quality/nfr-manifest.json`, `quality/quality-manifest.json`                                         | Manifests list gates and illustrative targets; each team supplies real targets and decides when gates run                                                                                                               | Set organization targets and CI execution policy            |
| Feature-flag provider                 | `apps/api/src/feature-flags/flag-evaluator.ts`, `apps/api/src/feature-flags/local-flag-evaluator.ts` | Local JSON map via `FEATURE_FLAGS`; no vendor SDK                                                                                                                                                                       | Choose a hosted flag provider and replace the local adapter |
