---
name: developer
description: Implements one task from a plan or a prompt. Loads the API contract skill before endpoint edits and the UI standards skill before screen edits, requires a reviewed migration for a schema change, and names the quality gates the change must pass. Use when writing or changing code in this repository.
---

# Developer

## Purpose

The developer skill serves a Developer, or a development agent acting for one. It classifies the task, loads the required skills before any code is written, and names the gates the change must pass. It stops when a required reference is missing instead of guessing.

## When to use

Use this skill for every code, documentation, or configuration change. Use the planner skill first when the task is still a prompt with no plan. Do not use this skill to score gates or to decide pipeline readiness.

## Inputs

Read these when the task needs them. Paths are relative to the repository root.

- The task, or the plan from the planner skill
- [API contract skill](../api-contract/SKILL.md) (`.cursor/skills/api-contract/SKILL.md`), when the task adds or changes an endpoint
- [UI standards skill](../ui-standards/SKILL.md) (`.cursor/skills/ui-standards/SKILL.md`), when the task adds or changes a screen
- [UI role skill](../ui/SKILL.md) (`.cursor/skills/ui/SKILL.md`), when the task adds or changes a screen, after the UI standards skill
- [Quality manifest](../../../quality/quality-manifest.json) (`quality/quality-manifest.json`)
- [Quality guide](../../../quality/README.md) (`quality/README.md`)
- [Migrations runbook](../../../docs/runbooks/migrations.md) (`docs/runbooks/migrations.md`), when the schema changes
- Schema file: `apps/api/src/persistence/schema.ts`, when the schema changes
- [Testing guide](../../../docs/testing.md) (`docs/testing.md`)
- [Feature slices](../../../docs/feature-slices.md) (`docs/feature-slices.md`), when the task adds a feature slice
- [Build artifacts](../../../docs/plans/README.md) (`docs/plans/README.md`), when the task comes from a brief

## Required references

Classify the task with the table in Procedure before the first edit. Load every skill that row requires. If a required skill file or other required path cannot be read, stop and report the missing reference instead of guessing. Write no code after that stop.

## Rules

The Enforced by cell is a gate id from `quality/quality-manifest.json`, or `Review`.

| ID      | Rule                                                                                                                                                                                                                                                                              | Enforced by          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| DEV-R01 | An endpoint added or changed loads the API contract skill before any code is written.                                                                                                                                                                                             | Review               |
| DEV-R02 | A screen added or changed loads the UI standards skill before any code is written.                                                                                                                                                                                                | Review               |
| DEV-R03 | A schema change ships a reviewed SQL migration committed with the Drizzle change. Follow `docs/runbooks/migrations.md`. The application does not change the schema when it starts.                                                                                                | migration-validation |
| DEV-R04 | A missing required reference stops the task. Report the missing path instead of guessing.                                                                                                                                                                                         | Review               |
| DEV-R05 | Do not put a hard-coded secret or an identity value in code or tests. Use a synthetic value or an environment variable.                                                                                                                                                           | Review               |
| DEV-R06 | Documentation only, or configuration only, does not require the API contract skill or the UI standards skill. The applicable gates in the procedure table still apply.                                                                                                            | formatting           |
| DEV-R07 | A task that needs authorization, a production identity provider, or a performance target reads the recorded answer in the brief. A missing answer stops the task and asks the matching question in `docs/plans/README.md` verbatim. Write no code. A pause answer writes no code. | Review               |

## Procedure

1. Classify the task. Use the first matching row. A task can match more than one row. Apply every matching row.
2. Load each required skill before any code is written. Read the file. Do not rely on memory of it.
3. If a required reference file is missing, stop and report the missing reference instead of guessing.
4. Make the change. For a schema change, add the reviewed SQL migration in the same change as `apps/api/src/persistence/schema.ts`.
5. Run the gates for each matching row, using the `script` field in `quality/quality-manifest.json`. Do not treat a script name as a gate id.
6. List the gates you ran and the exit status of each. Do not call the build verified. The QA skill owns that verdict.

| Change type                 | Required skills                            | Gates                                                                                              |
| --------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Endpoint added or changed   | api-contract                               | build, type-check, lint, formatting, openapi-drift, routes-check, contract, unit, api, integration |
| Screen added or changed     | ui-standards                               | build, type-check, lint, formatting, unit, component, accessibility                                |
| Schema change               | api-contract when an endpoint also changes | migration-validation, integration                                                                  |
| Container definition change | none                                       | container-build                                                                                    |
| Documentation only          | none                                       | formatting, docs-validation                                                                        |
| Configuration only          | none                                       | build, type-check, lint, formatting                                                                |

Documentation only and configuration only do not require either skill. They still require the applicable quality gates in that row.

A schema change that also changes an endpoint uses both rows.

## Outputs

- The code, documentation, or configuration change
- The list of gates run, by manifest id, with each exit status
- For a screen, the UI role skill's evidence note at `quality/evidence/<slug>-ui.md`
- For a schema change, the reviewed SQL migration path

The change contains no hard-coded secret and no identity value.

## Review checklist

Mark each item yes, no, or not applicable. A no is a failure.

| Item                                                                                         | Evidence source                          | Met? (yes, no, not applicable) |
| -------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------ |
| Endpoint work loaded the API contract skill first (DEV-R01)                                  | The skill was read before the first edit |                                |
| Screen work loaded the UI standards skill first (DEV-R02)                                    | The skill was read before the first edit |                                |
| A schema change has a reviewed SQL migration (DEV-R03)                                       | `docs/runbooks/migrations.md`            |                                |
| A missing reference stopped the task (DEV-R04)                                               | The missing-path report                  |                                |
| Secrets and identity values are synthetic or environment variables (DEV-R05)                 | The diff                                 |                                |
| Documentation or configuration did not load an unneeded skill, and gates still ran (DEV-R06) | The gate list                            |                                |
| A missing brief answer stopped the task and asked the recorded question (DEV-R07)            | `docs/plans/README.md`                   |                                |

## Stop conditions

Stop and report the missing piece. Do not guess. Write no further code.

- `.cursor/skills/api-contract/SKILL.md` cannot be read and the task adds or changes an endpoint. Report that missing reference.
- `.cursor/skills/ui-standards/SKILL.md` cannot be read and the task adds or changes a screen. Report that missing reference.
- `quality/quality-manifest.json` cannot be read.
- A schema change is required and `docs/runbooks/migrations.md` or `apps/api/src/persistence/schema.ts` cannot be read.
- The task asks for a hard-coded secret or a real identity value in code or tests. Refuse the literal. Use a synthetic value or an environment variable.
- The task needs authorization, a production identity provider, or a performance target, and the brief has no answer. Ask the matching question in `docs/plans/README.md` verbatim.
- The brief records pause.

## Boundaries

- Do not invent roles, permissions, a user list, or a user lookup. The API contract skill and ADR 0002 own that boundary.
- Do not author pipeline, cloud-host, or infrastructure files.
- Do not claim the build is verified. The QA skill reports that.
- Do not claim the build is ready for a pipeline. The integration skill reports that.
- Do not skip the applicable quality gates because a skill was not required.
