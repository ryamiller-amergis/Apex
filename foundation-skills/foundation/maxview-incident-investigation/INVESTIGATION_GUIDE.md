# MaxView Investigation Guide

The "how" for `maxview-incident-investigation`. Any read-only, secret-safe command relevant to your current hypothesis is fair game. You pick the queries; this guide does not prescribe them.

This guide stays general across all incident types. App- and surface-specific facts (resource names, dependencies, hosts) live only in `RESOURCE_CATALOG.md` — look them up there, don't hard-code them here.

## Read-Only Boundary

Allowed:

- Telemetry queries (Application Insights, Log Analytics, metrics, alerts).
- Azure `show` / `list` / `get` / `query` inspection.
- Repo search, source reading, git history.
- Read-only pipeline metadata/log inspection.

Forbidden without explicit user approval:

- Anything that changes state: create, update, delete, restart, deploy, purge, rotate, import, apply, scale, swap, resubmit, replay.
- Terraform apply/import/state changes; app-setting or firewall/WAF edits; queue purges; restarts; slot swaps.
- ADO work items, branches, commits, pushes, PRs.

Secrets:

- Never print connection strings, instrumentation keys, SAS/storage/Service Bus keys, Key Vault values, passwords, auth headers, or full app-setting values.
- Report a name or presence/absence only. If a command returns a secret, keep the non-secret fact and drop the value.

## Investigation Loop

*Where* to look is domain routing (below). *How* to query is your call — choose and verify it live.

1. Identify the surface from the clue: app, environment, route/job/queue, operation ID, error text, timestamp, user action, or alert.
2. Form one or two hypotheses and pursue them.
3. Go to the highest-signal surface:
   - **Operation ID:** correlate all telemetry for that operation first.
   - **User-facing error (500 / "internal server error" / broken page):** suspect a failed downstream dependency, not just the app itself. A request can return `200`/`302` while the real failure is a dependency call — check dependencies early. Look up the affected surface's dependencies in `RESOURCE_CATALOG.md`.
   - **Queue / integration:** check consumer traces, dependency failures, Service Bus counts, and dead-letter/backlog.
   - **Network:** check firewall/WAF/Front Door only when the symptom points to the edge.
4. When telemetry matters, capture compact metrics for the same resource and window as the finding.
5. Keep digging until evidence supports a root cause or you hit a real external blocker. If a query is empty, apply the Zero-Result Rule before concluding anything.

## Zero-Result Rule

Zero or thin rows almost always means a wrong query — not absent data. Assume the query is wrong and self-correct before describing anything as missing:

- Confirm the right subscription, resource group, and resource for the app/environment.
- Try alternate tables/schemas and field names — don't trust one query path.
- Correct for sampling so row counts don't understate volume.
- Fix time-zone and incident-window boundaries.
- Get a broad unfiltered baseline for that resource/window, then compare.
- Drop over-specific filters (route, result code, operation, role, host, dependency target).

Until you exhaust these, say only: "this query returned no rows for the filters used." Absence is reportable only after multiple independent approaches fail — and even then it is a limitation, never a root cause, especially when a nearby window/resource/path has data.

If Azure auth or access drops mid-investigation, stop and report it as partial/blocked. Never promote an unverified empty result into the finding.

## Reporting

Use the **RCA Output** template in `SKILL.md`. Keep it short and evidence-led:

- Include only sections that add signal. Skip network/firewall or config/code evidence that found nothing.
- Prefer a few precise facts over big tables or raw counts. Tie every metric to the root cause or decision.
- When telemetry supports the finding, include: time window, total affected events, failure count/rate, top failing request/dependency/exception, result codes, first/last seen, and 1–2 sample operation IDs.
- Note the main alternatives you ruled out and why — it raises confidence and prevents re-investigation.
- When evidence is insufficient, state exactly what is missing.

For frequent/intermittent incidents, when data allows:

- **Scope:** environment, resource, dependency/request/exception family, window.
- **Volume:** failures out of total, plus failure rate.
- **Timeline:** first failure, first burst, latest failure, and whether successes occur during/after.
- **Breakdown:** top failing endpoints/dependencies/exceptions with counts and dominant result codes.
- **Baseline:** compare to prior days or a known-good period.
- **Verdict:** outage, intermittent, degradation, normal noise, or insufficient evidence.

## Next Action

- **Bug:** user-facing defects, regressions, failing endpoints, data defects, unhandled exceptions, broken integrations.
- **TBI:** infrastructure, monitoring, alerting, Terraform, runbooks, access, logging, deployment/observability hardening.
- **Continue investigation:** only after read-only avenues are exhausted and the next step needs something you can't get read-only (credentials, portal access, prod approval, affected-user details, logs outside your telemetry). Not because a query was empty or confidence is low — keep digging first.
