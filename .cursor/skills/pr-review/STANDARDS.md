# Standards behind the PR review lenses

Cite these by name and section in findings. Versions were checked in November 2026. If a link moves, search the title.

## Review process

| Source | Use it for |
|---|---|
| [Google Engineering Practices: Code Review](https://google.github.io/eng-practices/review/reviewer/) | The approval bar (improves code health), what to look for, speed, handling pushback, small CLs |
| [Conventional Comments](https://conventionalcomments.org) | Comment labels and decorations (`issue`, `suggestion`, `question`, `praise`, `nit`) |
| [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) | Commit and PR title format when the repo uses it |
| [Semantic Versioning 2.0.0](https://semver.org) | Judging whether a shared-contract change is breaking |
| [NIST SP 800-218 SSDF](https://csrc.nist.gov/pubs/sp/800/218/final) | Review as a secure-development practice (PW.7 code review, PW.8 testing) |

## Security

| Source | Use it for |
|---|---|
| [OWASP ASVS 5.0.0](https://asvs.owasp.org/) (30 May 2025) | Testable requirements. Cite as `v5.0.0-<chapter>.<section>.<req>`. Chapters used most: authentication, session, access control, validation and encoding, API and web service, file handling, logging, configuration |
| [OWASP Top 10:2025](https://owasp.org/www-project-top-ten/) | Broad risk categories for finding titles |
| [OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x00-header/) | API1 object-level authorization, API2 authentication, API3 property-level authorization and mass assignment, API4 resource consumption, API5 function-level authorization, API6 sensitive business flows, API7 SSRF, API8 misconfiguration, API9 inventory, API10 unsafe consumption of upstream APIs |
| [CWE Top 25](https://cwe.mitre.org/top25/) | A CWE id for a specific weakness (for example CWE-89 SQL injection, CWE-79 XSS, CWE-918 SSRF, CWE-862 missing authorization) |
| [RFC 9700, OAuth 2.0 Security BCP](https://www.rfc-editor.org/rfc/rfc9700) (Jan 2025) | Auth code flow with PKCE, exact redirect URI match, no implicit or password grant |
| [RFC 8725, JWT BCP](https://www.rfc-editor.org/rfc/rfc8725) | Algorithm pinning, audience and issuer checks, expiry |
| [WHATWG Fetch: CORS](https://fetch.spec.whatwg.org/#http-cors-protocol) | Origin allow-lists; no `*` with credentials |
| [Express: Security best practices](https://expressjs.com/en/advanced/best-practice-security.html) | Helmet, cookie flags, rate limits, no stack traces in production |
| [SLSA v1.0](https://slsa.dev/spec/v1.0/) | Build provenance and pipeline integrity for CI and deploy workflow changes |

Auth review questions for every new route:

1. Who is the caller (authentication)?
2. May this caller call this function (function-level, `requirePermission`)?
3. May this caller touch this object (object-level, project scoping)?
4. May this caller read or write each field (property-level, no mass assignment)?
5. What does it cost to call this a million times (resource limits)?

## HTTP and API design

| Source | Use it for |
|---|---|
| [RFC 9110, HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110) | Method safety and idempotency (GET never mutates; PUT and DELETE idempotent), status codes (401 vs 403, 404 vs 410, 409 conflict, 422 vs 400, 429), conditional requests |
| [RFC 9457, Problem Details](https://www.rfc-editor.org/rfc/rfc9457) | Machine-readable error body (`application/problem+json`); obsoletes RFC 7807. Never leak stack traces or internals |
| [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585) | 429 Too Many Requests with `Retry-After` |
| [RFC 8594, Sunset header](https://www.rfc-editor.org/rfc/rfc8594) | Deprecating an endpoint |
| [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) | Describing and diffing the contract |
| [WHATWG HTML: Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) | SSE framing, `Last-Event-ID` resume, reconnect behavior (used for notifications and chat streaming) |
| [W3C Trace Context](https://www.w3.org/TR/trace-context/) | Propagating `traceparent` across the API, workers, and runners |

## Data and PostgreSQL

| Source | Use it for |
|---|---|
| [PostgreSQL: Explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) | Which migration statements take `ACCESS EXCLUSIVE` and block reads |
| [PostgreSQL: CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html) | `CONCURRENTLY` cannot run in a transaction block; plan the migration accordingly |
| [PostgreSQL: ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) | Rewrite vs metadata-only changes; `NOT NULL` with default; adding constraints `NOT VALID` then `VALIDATE` |
| [Drizzle ORM docs](https://orm.drizzle.team/docs/overview) | Typed queries, relational API, transactions |
| [node-pg-migrate](https://salsita.github.io/node-pg-migrate/) | Up and down migrations, ordering |

Safe-migration checks: no destructive change in the same release as the code that stops using the column; backfill in batches; `down` exists and works; the migration is idempotent where the runner may retry.

## TypeScript, Node, Express

| Source | Use it for |
|---|---|
| [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) | Narrowing, discriminated unions, `unknown` over `any` |
| [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices) | Error handling, async patterns, graceful shutdown, config validation |
| [Express: Error handling](https://expressjs.com/en/guide/error-handling.html) | Async handler errors reach the error middleware; one error contract |
| [The Twelve-Factor App](https://12factor.net) | Config in environment, stateless processes, logs to stdout, disposability |
| [zod](https://zod.dev) | Validate every external input at the boundary and infer the type from the schema |

## React and frontend

| Source | Use it for |
|---|---|
| [React: Rules of Hooks](https://react.dev/reference/rules-of-hooks) | Hook order and conditions |
| [React: You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect) | Derived state, event handlers, resets by `key`, avoiding effect chains |
| [React: Keeping components pure](https://react.dev/learn/keeping-components-pure) | Render purity and Strict Mode double-invocation safety |
| [TanStack Query docs](https://tanstack.com/query/latest/docs/framework/react/overview) | Query keys, invalidation, optimistic updates, in-flight deduplication |
| [Testing Library: Guiding principles](https://testing-library.com/docs/guiding-principles/) | Query by role and text; test what the user sees |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) (W3C Recommendation) | Level AA success criteria. Frequent hits: 1.4.3 contrast, 1.4.11 non-text contrast, 2.1.1 keyboard, 2.4.7 focus visible, 2.4.11 focus not obscured, 2.5.8 target size, 4.1.2 name, role, value |
| [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/) | Keyboard and ARIA patterns for dialogs, tabs, menus, comboboxes |

Strict Mode note: effects and mounts run twice in development. Flag any non-idempotent work started in an effect or render (duplicate requests, double subscriptions).

## Cloud, infra, and operations

| Source | Use it for |
|---|---|
| [Azure Well-Architected Framework](https://learn.microsoft.com/azure/well-architected/) | Reliability, security, cost, operational excellence, performance pillars |
| [Azure Architecture: Cloud design patterns](https://learn.microsoft.com/azure/architecture/patterns/) | Retry, circuit breaker, queue-based load leveling, idempotent consumer, competing consumers |
| [Terraform style guide](https://developer.hashicorp.com/terraform/language/style) | Naming, variables, outputs, file layout (see also `.cursor/skills/terraform-infra/SKILL.md`) |
| [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/) | Attribute names for spans, metrics, and logs |
| [GitHub Actions security hardening](https://docs.github.com/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions) | Pin actions, least-privilege `GITHUB_TOKEN`, no untrusted input in `run:` |

Cloud checks: no assumption of a local disk surviving a restart; no state held in one process that a second instance needs; every outbound call has a timeout; retries are bounded and the work is idempotent; secrets come from the platform, not the repo.

## Where a lesson for the next agent belongs

Public standards in this file are citations for a finding. They are not Apex policy. When a review recommends a rule, skill, or doc update, the home is one of the repo files in the skill's "Guidance for the next agent" table. Do not add a new house rule that only restates OWASP, an RFC, WCAG, or Postgres.

## Common defects in this stack

Look for these first. They follow from the repo rules and from defects found in recent work.

- A new route with `requirePermission` on the UI but not on the server.
- A project-scoped resource fetched by id without a project check.
- `useEffect` that fetches data or copies props into state.
- A `useMutation` or request started in an effect with no in-flight dedupe, so Strict Mode fires it twice.
- An outbound call with no timeout in a request hot path.
- A migration that adds a `NOT NULL` column without a default on a large table, or an index built without `CONCURRENTLY`.
- `schema.ts` out of step with the migration.
- A table pushed past 50 columns.
- An accent-colored button with `color: var(--bg-primary)` instead of `var(--on-accent)`.
- A test that mocks the function it claims to test.
- A git or network test with the default 5 s Jest timeout.
- An error caught and logged without being returned or rethrown, leaving the caller to wait forever.
- A path listed in `.cursor/CODEMAP.md` that was moved or deleted.
