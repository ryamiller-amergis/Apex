# Design — Provider-Neutral Feature Flag Interface

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Should Have | **Feature flag:** `None`
> **Parent Epic:** Reference API and Platform Services | **Affected personas:** Developer
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (2 unresolved)

---

## Feature Summary

**Feature ID:** FEAT-008 (depends on FEAT-001)

**Description:** Generated applications need a way to ship unfinished behavior switched off, and to switch it on later, without a rewrite when the team picks a flag provider. This Feature gives a Developer a small interface that answers one question: "Is the flag named X on?" A local adapter answers it from the application's configuration and adds no vendor SDK. When a team picks a provider, it writes a new adapter, and the code that asks the question does not change.

This is a capability of the generated application, in the template folder `templates/full-stack-express/`. It is separate from Apex's own Feature Flag system in Platform Admin.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-019 | TBI | Create the flag-evaluation interface and local adapter | Should Have |
| PBI-016 | PBI | Gate new behavior behind a flag | Should Have |

---

## Scope and Out-of-Scope

**In scope:**
- A flag-evaluation interface that takes a flag name and a default value and returns a boolean (TBI-019).
- A local adapter that reads flag values from the typed configuration, through one optional environment variable (TBI-019).
- The declared default for any flag the configuration does not define, with no error (PBI-016).
- The declared default, plus one logged warning, when the adapter cannot read its configuration (PBI-016).
- Wiring the evaluator into the API composition root so route code can receive it (PBI-016).
- Replacing the local adapter with another implementation of the interface and no change to call sites (PBI-016).
- Unit and API tests for on, off, unknown, unreadable configuration, request-input immunity, and replacement (TBI-019).
- A guard test that the workspace has no vendor flag SDK dependency (TBI-019).

**Out of scope:**
- Selecting or integrating a flag provider, and any hosted flag service.
- Targeting rules and rollout management.
- Per-user or per-group targeting.
- Flag administration screens.
- Flag tables or columns in the database (`app_users` holds no flag data).
- A web-client hook, or an HTTP endpoint that returns flag values (this spec assumes server-side use only).
- Flag values other than on and off, and reloading values without a restart.
- Any use of Apex's Feature Flag system, `isFeatureEnabled`, or `useFeatureFlag`.
- Any sample flag that changes how the reference profile or health endpoints behave.

---

## Target Surface

**Primary surface:** Backend only (Express server)

**Experience notes:** The user is a Developer working in code. There is no screen, no Apex navigation entry, and no change to the reference profile screen. Developers meet the feature in three places: a `FEATURE_FLAGS` row in the README and `.env.example`, a module map entry, and the `FlagEvaluator` type in the API composition root.

---

## Access Control

The template defines no roles, permissions, or authorization policy (BR-003). This Feature adds no endpoint and no permission key.

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Evaluate a flag in application code | Any code in the API process; no authentication and no role | Global (one value per application instance) |
| Set a flag value | Whoever deploys the instance, by setting the `FEATURE_FLAGS` environment variable and restarting; no in-application administration | Global |
| Change a flag value from a request | No one; request headers, query strings, bodies, and cookies never reach the evaluator | Not applicable |
| Replace the local adapter with a provider adapter | A Developer of the generated application, through code review | Global |
| Review the template and move it to the bootstrap source | Platform Engineering (mapped to `Platform Admin` in the backlog) | Global |

**Feature flag:** `None` — rollout: None. The PRD sets "Flag required: No". This Feature does not use an Apex Feature Flag.
**Behavior when flag is off:** Not applicable. Inside the template, the equivalent state is an unset `FEATURE_FLAGS` variable: every evaluation returns the default the caller declared.

---

## Acceptance Criteria

### PBI-016 — Gate new behavior behind a flag

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A flag is set on in configuration | My code evaluates it | The interface returns true and the gated behavior runs |
| (b) Error/failure | The local adapter cannot read its configuration (the value is not valid JSON, or a key or value has the wrong shape) | My code evaluates a flag | The interface returns the flag's declared default, logs one warning that names the variable and a reason code, and throws no error |
| (c) Edge case/boundary | A flag name is not defined anywhere (or the variable is unset or empty) | My code evaluates it | The declared default is returned and no error is thrown; nothing is logged for an unset or empty variable |
| (d) Negative scenario | A flag is on in configuration, or off | A request carries a header, query parameter, cookie, or body that names that flag with a different value | The evaluator ignores it and returns the configured value; request input never sets a flag |
| (e) Adapter replacement (backlog criterion) | I replace the local adapter with another implementation of the interface | My code evaluates a flag | It works with no change to the call sites |

Scenario (d) comes from the PBI-016 security requirement: "Flag values come from configuration and are never taken from request input."

### TBI-019 — Create the flag-evaluation interface and local adapter

TBI-019 has no user-facing scenarios. Its definition of done, each item tied to a verification test in the [tech spec](design-doc-tech-spec.md):

- The interface evaluates a flag by name and returns the declared default for an unknown flag (VT-01, VT-02, VT-03).
- The local adapter reads values from configuration (VT-01, VT-09).
- The workspace has no vendor flag SDK dependency (VT-10).
- Unit tests cover on, off, unknown flag, and a replacement adapter (VT-01, VT-02, VT-03, VT-07).
- Evaluation is synchronous, so request handling never waits on a provider (VT-11).

---

## UI/UX

Not applicable. This Feature is backend only. Flag administration screens are out of scope.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
