---
name: maxview-incident-investigation
description: Investigates production or lower-environment incidents across the MaxView umbrella, including Main TimeClock, ClientApp/WebApp, MaxHub, TimeClock Integration, Credentialing Integration, jobs, AccessControl/UAM, Azure resources, Application Insights, Log Analytics, firewall/WAF logs, Service Bus, and deployment evidence. Use when the user provides an operation ID, resource name, symptom, exception, failed request, alert, or asks for root cause analysis before deciding whether to file a Bug or TBI.
user_invocable: true
---

# MaxView Incident Investigation

Read-only investigation of any MaxView app or integration. Turn a loose clue into a root cause with evidence, confidence, and a recommended next action.

## Trigger

`/maxview-incident-investigation`

Also activates on: "investigate MaxView logs", "check App Insights", "query firewall logs", "operation ID", "find exceptions", "root cause this issue", "should we file a bug".

## Read first

- [RESOURCE_CATALOG.md](RESOURCE_CATALOG.md) — which app / resource / environment to look at.
- [INVESTIGATION_GUIDE.md](INVESTIGATION_GUIDE.md) — read-only rules, the zero-result recovery procedure, and how to report evidence.

If `az account show` fails, run `az login --identity --client-id "$AZURE_INSIGHTS_CLIENT_ID" --output none`, and stop if that variable is missing or the login fails.

## Workflow

1. **Intake.** Take any clue: operation ID, exception, app/resource, environment, route, alert, time window, IP, queue/topic, or plain symptom. If environment or time window is missing and cannot be inferred, ask one short question. Otherwise proceed and state your assumptions.
2. **Scope.** Use `RESOURCE_CATALOG.md` to pick the surface and the correct resource. Attribute the symptom to the app that owns the failing surface and use *that* app's telemetry resource — a neighbouring app's resource can look empty or wrong even in the same environment.
3. **Investigate.** You choose every read-only query yourself. This skill gives you no tables, schemas, fields, or KQL on purpose — discover and verify them live. Follow the Persistence Mandate.
4. **Correlate.** Weigh telemetry, dependency failures, config/runtime state, deployment timing, code, and network evidence — only where each is relevant. Separate fact from inference.
5. **Report.** Only after reaching a well-supported conclusion, produce the RCA (see RCA Output).
6. **Hand off.** Recommend a next action and stop. Change nothing without explicit user approval.

## Persistence Mandate

Reliability comes from not stopping early. Keep going until you have an evidence-backed root cause, or you hit a real external blocker you cannot get past read-only (missing credentials, portal-only access, prod approval) — then name that blocker.

- Zero or thin rows might mean that your query is probably wrong, not that data is missing. Vary the table, schema, fields, time zone, filters, and query path, and correct for sampling before coming to that conclusion.
- Never make "no telemetry / data gap / data missing" a finding when any nearby window, resource, or query path returns data.
- Do not stop at the first plausible answer, and do not hand a zero-result back to the user while read-only options remain.

## Hard Rules

- Read-only until the user explicitly approves a change in this chat.
- No create/update/delete/restart/deploy/purge/rotate/scale, no Terraform apply, no app-setting or firewall edits, no commits/pushes, no ADO work items.
- Never print secrets (connection strings, keys, tokens, auth headers, passwords, full app-setting values). Report presence/absence only.
- Never say "no telemetry" from an empty query. Say "this query returned no rows for the filters used" and keep digging.
- Omit evidence sections that add nothing. Keep production mitigations behind human approval.

## RCA Output

The one canonical report shape. Omit any section that adds nothing.

```markdown
## Finding
[What is failing and the most likely cause.]

## Impact
[Environment, app, route/job/queue, users, frequency, time window.]

## Evidence
[Only what supports or rules out the finding. When telemetry is relevant: affected count/rate, result codes, first/last seen, top failing operation/dependency/exception, and 1–2 sample operation IDs.]

## Root Cause
[Direct cause and contributing factors. Label assumptions.]

## Confidence
[High | Medium | Low] — [why]

## Recommended Next Action
[Bug, TBI, runbook action, continue investigation, fix plan only, or no action.]
```

## Work Item Handoff

- **Bug:** load `file-bug/SKILL.md` and pass the RCA as evidence.
- **TBI:** draft a summary (title, problem, evidence, proposed change, likely files/resources, acceptance criteria, validation, risk, rollback). Ask before creating anything in ADO.
