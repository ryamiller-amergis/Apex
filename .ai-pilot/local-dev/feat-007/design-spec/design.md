# Design — Observability and Graceful Shutdown

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Reference API and Platform Services | **Affected personas:** Developer, Platform Admin
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (4 unresolved)

---

## Feature Summary

**Description:** Generated applications start with no way to follow one request through the logs, no telemetry, and no controlled stop. This Feature gives the sample API structured JSON logs with request IDs and identity redaction, OpenTelemetry traces and metrics that Platform Engineering connects through environment settings, and a shutdown that finishes in-flight requests, closes database connections, and flushes telemetry within a set time limit. Developers diagnose problems without seeing personal data, and Platform Admin deploys new versions without dropped requests. The end state is an API that logs and exports telemetry with no cloud-vendor code and that exits with a clear status on every stop.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-016 | TBI | Add Pino structured logging with request IDs and redaction | Must Have |
| TBI-017 | TBI | Add OpenTelemetry traces and metrics with environment-configured exporters | Must Have |
| TBI-018 | TBI | Add graceful shutdown | Must Have |
| PBI-013 | PBI | Follow one request through the logs by its request ID | Must Have |
| PBI-014 | PBI | Connect telemetry exporters through environment settings | Should Have |
| PBI-015 | PBI | Stop an instance without dropping in-flight requests | Must Have |

**Dependencies:** TBI-017 and TBI-018 depend on TBI-016. PBI-013 depends on TBI-016, PBI-014 on TBI-017, and PBI-015 on TBI-018. The Feature depends on FEAT-001 (Isolated pnpm Workspace and Pinned Toolchain). Implementation also needs TBI-004 (typed environment validation, FEAT-002) and TBI-006 (data-access module, FEAT-003). See the assumptions file.

---

## Scope and Out-of-Scope

**In scope:**
- A logging module that writes single-line JSON with a request ID and correlation ID on request-scoped entries, sets the log level from the environment, and redacts display name, email, and external subject from request, response, and error logs, including nested fields and error objects (TBI-016, PBI-013).
- Request ID middleware that reuses a valid caller value and replaces an over-long or malformed one (PBI-013).
- OpenTelemetry traces and metrics for HTTP requests and database calls, with exporter choice and endpoint set only by environment variables, a clean disabled mode, and span attributes that exclude identity values (TBI-017, PBI-014).
- Graceful shutdown on a termination signal: refuse new connections, let in-flight requests finish within a configured time limit, flush telemetry, close database connections, and exit (TBI-018, PBI-015).
- Readiness that reports not ready while the instance shuts down (PBI-015 (d)). The readiness endpoint itself belongs to FEAT-006.
- A log line that names the abandoned work when the time limit passes (PBI-015 (b)).

**Out of scope:**
- AWS-specific CloudWatch instrumentation in application code (Feature).
- Dashboards and alert rules (Feature).
- Log shipping and retention (PBI-013).
- Log search tooling (PBI-013).
- Provisioning collectors or AWS resources (PBI-014).
- Alert rules (PBI-014).
- Load balancer deregistration (PBI-015).
- ECS stop timeout settings (PBI-015).
- Any change to Apex runtime behavior, its database, or its services (PRD Out of Scope).
- An HTTP endpoint that starts a shutdown, and process-level handlers for uncaught exceptions (see assumptions).

---

## Target Surface

**Primary surface:** Backend only (Express server)

**Experience notes:** Not applicable. The template's web client is not touched. Developers read logs and Platform Admin sets environment variables and sends signals. The PRD classes the whole template as full-stack, and this Feature changes only the API side.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Read the request ID on a response and find it in logs | Developer, using the log output of their own environment | No restriction |
| Connect trace and metric exporters through environment settings | Platform Admin (Platform Engineering), by setting deployment environment variables | Not applicable |
| Stop an instance with a termination signal | Platform Admin (Platform Engineering), through the process or container orchestrator | Not applicable |
| Check readiness while an instance shuts down | Anyone who can reach the instance, with no credentials (PRD: health endpoints need no authentication) | No restriction |

The template defines no roles, permissions, or authorization policy (BR-003). This Feature adds no endpoint that needs authorization. No HTTP endpoint starts a shutdown or changes telemetry settings.

**Feature flag:** `None` — rollout: Not applicable (the PRD sets "Flag required: No")
**Behavior when flag is off:** Not applicable. A project turns telemetry off with `OTEL_SDK_DISABLED=true`, which needs no redeploy of code.

---

## Acceptance Criteria

### PBI-013 — Follow one request through the logs by its request ID

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A request is handled | I read the response header and the logs | The same request ID appears on the response and on every log entry for that request |
| (b) Error/failure | A request fails with an unhandled error | I read the logs | The error is logged with the request ID and without identity values or the raw request body |
| (c) Edge case/boundary | A caller supplies its own request ID header | The request is handled | A valid value is reused, and an over-long or malformed value is replaced with a generated one |
| (d) Negative scenario | A profile update contains a display name and email | I search the captured logs for those values | Neither value appears in any log entry |

### PBI-014 — Connect telemetry exporters through environment settings

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I set the exporter endpoint in the environment | The application handles requests | Traces and metrics are sent to that endpoint |
| (b) Error/failure | The exporter endpoint is unreachable | The application handles requests | Requests still succeed and the export failure is logged without identity values |
| (c) Edge case/boundary | No exporter is configured | The application starts | It runs normally with telemetry disabled |
| (d) Negative scenario | I read the template's application code | I look for cloud-vendor exporter code | None exists; vendor choice is made only through environment settings |

### PBI-015 — Stop an instance without dropping in-flight requests

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A request is in progress | The instance receives a termination signal | The request completes and the process then exits with status zero |
| (b) Error/failure | A request does not finish within the time limit | The time limit passes after the signal | The process exits and logs which work was abandoned |
| (c) Edge case/boundary | No requests are in progress | The instance receives a termination signal | It exits promptly after closing database connections |
| (d) Negative scenario | The instance is shutting down | A new request or readiness check arrives | Readiness reports not ready and new connections are not accepted |

### TBI coverage

The three TBIs have no user-facing criteria. Their definitions of done map to the scenarios above and to the verification matrix in the tech spec:

| TBI | Definition-of-done items | Proved by |
|-----|--------------------------|-----------|
| TBI-016 | Single-line JSON with a request ID; identity fields redacted in request, response, and error logs; tests assert no seed or fixture identity value in logs; log level set by environment | PBI-013 (a)–(d); VT-01, VT-02, VT-09, VT-10 |
| TBI-017 | Traces and metrics for HTTP and database calls; exporter set only by environment; runs with no exporter; test confirms span attributes hold no identity values | PBI-014 (a)–(d); VT-11 to VT-16 |
| TBI-018 | In-flight requests complete within the limit; new connections refused; database and telemetry closed or flushed before exit; hanging request does not block exit beyond the limit | PBI-015 (a)–(d); VT-17 to VT-26 |

---

## UI/UX

Not applicable. This Feature is backend only and adds no screen, route, component, or `data-testid` attribute. Developers see its output as JSON log lines, an `X-Request-Id` response header, and the process exit status.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
