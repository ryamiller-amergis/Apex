---
name: planner
description: Turns one prompt into a plan grounded in the module map, the quality manifest, and the NFR manifest. Use before implementation, when a prompt describes a feature, or when work may be out of scope. This is the planner role skill. It writes a plan and does not write code.
---

# Planner

## Purpose

The planner serves a Developer, or a planning agent acting for one. It turns one prompt into a Markdown plan that names the modules touched, the applicable gates, and the NFR evidence required. It does not write code.

## When to use

Use this skill when a prompt describes a feature or a change, and before the developer skill runs. Do not use it to implement the change, to run gates, or to decide pipeline readiness.

## Inputs

Read these repository files. Paths are relative to the repository root. Stop if one of them cannot be read. Name the missing path and produce no plan.

- [Agent guide](../../../AGENTS.md) and [agent index](../../../docs/agent-index.txt)
- [Module map](../../../docs/module-map.md) (`docs/module-map.md`)
- [Feature slices](../../../docs/feature-slices.md) (`docs/feature-slices.md`)
- [Build artifacts](../../../docs/plans/README.md) (`docs/plans/README.md`)
- [Quality manifest](../../../quality/quality-manifest.json) (`quality/quality-manifest.json`)
- [Quality guide](../../../quality/README.md) (`quality/README.md`)
- [NFR manifest](../../../quality/nfr-manifest.json) (`quality/nfr-manifest.json`)
- [README](../../../README.md)
- [ADR 0002](../../../docs/adr/0002-no-roles-or-permissions-in-the-template.md) (`docs/adr/0002-no-roles-or-permissions-in-the-template.md`)
- [Identity guide](../../../apps/api/src/identity/README.md) (`apps/api/src/identity/README.md`)
- [Migrations runbook](../../../docs/runbooks/migrations.md) (`docs/runbooks/migrations.md`)
- [Supply-chain runbook](../../../docs/runbooks/supply-chain.md) (`docs/runbooks/supply-chain.md`)
- [API contract skill](../api-contract/SKILL.md) (`.cursor/skills/api-contract/SKILL.md`)

If the prompt needs an ownership row or a decision that none of these files record, read the handoff document linked from `AGENTS.md`. If `AGENTS.md` does not link a handoff document, stop and report that the handoff document is not linked from AGENTS.md. Produce no plan. Do not invent a handoff path.

## Required references

The Inputs list is the required set. Read every path before writing a plan. A missing path is a stop, not a guess.

## Rules

The Enforced by cell is a gate id from `quality/quality-manifest.json`, or `Review`.

| ID      | Rule                                                                                                                                                                                                                                                                                                                  | Enforced by |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| PLN-R01 | Read every Inputs path before writing a plan. If one cannot be read, name the missing path and produce no plan.                                                                                                                                                                                                       | Review      |
| PLN-R02 | Name workspace members only from `docs/module-map.md`. Name feature slices only with the profile shape in `docs/feature-slices.md`. Do not invent a workspace member.                                                                                                                                                 | Review      |
| PLN-R03 | List applicable gates by id from `quality/quality-manifest.json`. Do not copy script names into the plan as if they were ids.                                                                                                                                                                                         | Review      |
| PLN-R04 | When an NFR target has `illustrative` set to true, the plan says real targets are missing and load-test evidence is out of this plan. Do not copy the numeric examples into the plan as targets. Copy a number only when the brief records one the person supplied.                                                   | Review      |
| PLN-R05 | Mark pipeline, cloud-host, and infrastructure work as Excluded work, owned by Platform Engineering. The template ships scripts a pipeline can call. It does not ship the pipeline.                                                                                                                                    | Review      |
| PLN-R06 | A request for a user list, user create, user lookup, roles, or permissions asks the Authorization question when the brief has no answer. Do not invent a role model. A Stay answer keeps the plan on the caller's own data. A Pause answer produces no plan.                                                          | Review      |
| PLN-R07 | The plan contains no secrets and no identity values. Use no real names, no credentials, and no email addresses.                                                                                                                                                                                                       | Review      |
| PLN-R08 | When the prompt needs authorization, a production identity provider, or a performance target, read the answer in the brief. If the brief has no answer, stop and ask the matching question in `docs/plans/README.md` verbatim. Produce no plan. Do not invent a role model, an identity provider, or a target number. | Review      |

## Procedure

1. Read every file under Inputs. If one cannot be read, stop, name the missing path, and produce no plan.
2. Read the brief when one exists. If the prompt needs authorization, a production identity provider, or a performance target, and the brief has no answer, stop and ask that question from `docs/plans/README.md` verbatim. Produce no plan.
3. Split the prompt into in-scope work, work owned by Platform Engineering, and work that needs an open decision.
4. For in-scope work, name each workspace member from `docs/module-map.md` and quote that entry's responsibility. Name each feature slice from `docs/feature-slices.md` and name the profile files it copies.
5. Choose applicable gates from the table below. Copy ids from `quality/quality-manifest.json`. The manifest stays authoritative if this table and the file ever disagree: stop and name the mismatch. Do not invent an id.
6. Read `quality/nfr-manifest.json`. For each target, name the NFR evidence required: the target name and the `verifiedBy` path. When `illustrative` is true, write that real targets are missing and that load-test evidence is out of this plan, unless the brief records numbers the person supplied. Do not use the example numbers as the project's targets.
7. Name skills to load: `api-contract` for an endpoint, `ui-standards` for a screen, or none.
8. Write the plan to `docs/plans/<slug>.md` using the slug from the brief. When no brief names a slug, write the plan in the reply and do not invent a path. Do not write code.

| Change type                 | Gates                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| Endpoint added or changed   | build, type-check, lint, formatting, openapi-drift, routes-check, contract, unit, api, integration |
| Screen added or changed     | build, type-check, lint, formatting, unit, component, accessibility                                |
| Schema change               | migration-validation, integration                                                                  |
| Container definition change | container-build                                                                                    |
| Documentation only          | formatting, docs-validation                                                                        |
| Configuration only          | build, type-check, lint, formatting                                                                |

A schema change that also changes an endpoint includes the endpoint row as well.

Out-of-scope classification, using only the Inputs files:

- Pipeline, cloud host, image publishing, and infrastructure: Excluded work, owned by Platform Engineering. Cite `docs/runbooks/supply-chain.md` (scripts a pipeline can call; each team decides when) and `docs/runbooks/migrations.md` (Platform Engineering runs migrations in shared environments). The API contract skill also stops for pipeline, cloud-host, or infrastructure changes.
- User list, user create, user lookup, roles, or permissions: ask the Authorization question when the brief has no answer. Cite ADR 0002 and `apps/api/src/identity/README.md`. Do not invent a role model. A Stay answer keeps the work on the caller's own data. A Pause answer produces no plan.
- Feature-flag provider: Open decisions flagged. Cite the flag-provider paragraph in `README.md` and the call in `apps/api/src/index.ts`.

## Outputs

A Markdown plan with these parts, and no others:

- Prompt summary
- Modules touched, with the module-map entry for each
- Feature slices, with the profile files copied, or "none"
- Applicable gates, using manifest gate ids
- NFR evidence required, plus the statement "real targets are missing" when values are only illustrative
- Skills to load (`api-contract`, `ui-standards`, or none)
- Excluded work, owned by Platform Engineering, with the file that records that ownership
- Open decisions flagged, with the file and the extension point
- Recorded answers for authorization, identity, and performance, or "not asked"
- Missing references (or "none")

The plan contains no secrets and no identity values.

## Review checklist

Mark each item yes, no, or not applicable. A no is a failure.

| Item                                                                                | Evidence source                                   | Met? (yes, no, not applicable) |
| ----------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------ |
| Every Inputs path was read, or the plan was not written (PLN-R01)                   | The missing-path line, or the plan                |                                |
| Modules come from the module map, and slices from the feature-slice guide (PLN-R02) | `docs/module-map.md` and `docs/feature-slices.md` |                                |
| Gates are manifest ids (PLN-R03)                                                    | `quality/quality-manifest.json`                   |                                |
| Illustrative NFR values are not used as targets (PLN-R04)                           | `quality/nfr-manifest.json`                       |                                |
| Infrastructure work is excluded (PLN-R05)                                           | Excluded work section                             |                                |
| RBAC and user-list requests invent no roles (PLN-R06)                               | ADR 0002                                          |                                |
| The plan has no secrets or identity values (PLN-R07)                                | The plan text                                     |                                |
| A missing brief answer asked the recorded question and produced no plan (PLN-R08)   | `docs/plans/README.md`                            |                                |

## Stop conditions

Stop and report the missing piece. Do not guess. Produce no plan.

- An Inputs path cannot be read. Name that path.
- The prompt needs authorization, a production identity provider, or a performance target, and the brief has no answer. Ask the matching question in `docs/plans/README.md` verbatim.
- The brief records pause. Name the extension point in that question's Pause line.
- The prompt needs an ownership row or a decision that none of the Inputs files record, and the handoff document is not linked from AGENTS.md. Name `AGENTS.md`. Do not invent a handoff path.
- A gate id in the procedure table is not in `quality/quality-manifest.json`. Name the id.

## Boundaries

- Do not write or edit application code, tests, or migrations.
- Do not run the quality gates. The QA skill does that.
- Do not decide pipeline readiness. The integration skill does that.
- Do not set an execution tier, a schedule, or a pipeline. `quality/README.md` says the manifests define none.
- Do not add roles, permissions, a user list, or a user lookup.
- Do not author pipeline, cloud-host, or infrastructure files.
