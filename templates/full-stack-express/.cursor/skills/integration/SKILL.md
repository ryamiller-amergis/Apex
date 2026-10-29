---
name: integration
description: Reads the quality manifest, the QA evidence report, and the recorded open decisions, and reports whether a build is ready for a pipeline. Use after the QA skill. This skill does not run gates, run a pipeline, or deploy.
---

# Integration

## Purpose

The integration skill serves Platform Admin, standing in for the people who run the pipeline. It reads the QA evidence and reports ready or not ready. It names every gap. It does not run the pipeline and it does not deploy. The readiness report is the status the person sees. The QA verdict stays in the evidence report.

## When to use

Use this skill after the QA skill has written an evidence report. Do not use it to re-run gates. Do not use it to start a pipeline or to deploy.

## Inputs

Read these before the verdict. Paths are relative to the repository root.

- [Quality manifest](../../../quality/quality-manifest.json) (`quality/quality-manifest.json`)
- [Quality guide](../../../quality/README.md) (`quality/README.md`)
- The QA evidence report for this build
- [README](../../../README.md), including the flag-provider paragraph and the `AUTH_MODE` table
- [Example environment](../../../.env.example) (the variable names `AUTH_MODE` and `NODE_ENV`)
- [Supply-chain runbook](../../../docs/runbooks/supply-chain.md) (`docs/runbooks/supply-chain.md`), for what the production image sets
- [ADR 0002](../../../docs/adr/0002-no-roles-or-permissions-in-the-template.md) (`docs/adr/0002-no-roles-or-permissions-in-the-template.md`)
- [Identity guide](../../../apps/api/src/identity/README.md) (`apps/api/src/identity/README.md`)
- API entry point: `apps/api/src/index.ts`
- [Agent guide](../../../AGENTS.md)
- [Build artifacts](../../../docs/plans/README.md) (`docs/plans/README.md`)
- [Container definition](../../../Dockerfile)

Production settings use the names in `.env.example`. The image described in `docs/runbooks/supply-chain.md` sets `NODE_ENV` to `production` and does not set `AUTH_MODE`. `AUTH_MODE=development` together with `NODE_ENV=production` is not allowed. That selection is the development authentication adapter selected for production.

## Required references

The Inputs list is the required set, except the handoff document. Open decisions that the Inputs files already record are listed from those files. If the build touches an extension point that none of the Inputs files record, read the handoff document linked from `AGENTS.md`. If that handoff document is not linked from AGENTS.md, the verdict is not ready. Do not invent a handoff path.

## Rules

The Enforced by cell is a gate id from `quality/quality-manifest.json`, or `Review`.

| ID      | Rule                                                                                                                                                                                                 | Enforced by |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| INT-R01 | Report ready only when every manifest gate is passed or deferred with a recorded reason and owner, and `AUTH_MODE` is not `development` when `NODE_ENV` is `production`.                             | Review      |
| INT-R02 | A required gate with no evidence is not ready. Name the gate. Do not claim readiness when any required gate lacks evidence.                                                                          | Review      |
| INT-R03 | List open decisions from ADR 0002 and from the flag-provider paragraph in `README.md`. If a handoff document is required and it is not linked from AGENTS.md, report not ready and name `AGENTS.md`. | Review      |
| INT-R04 | Do not run the pipeline and do not deploy. Readiness is a report. `docs/runbooks/supply-chain.md` says each team decides when a pipeline calls the scripts.                                          | Review      |
| INT-R05 | Do not re-run gates. Read the QA evidence report.                                                                                                                                                    | Review      |
| INT-R06 | The report contains no secrets and no identity values.                                                                                                                                               | Review      |

## Procedure

1. Read the quality manifest and the QA evidence report. If either cannot be read, stop and name the path. Produce a not ready verdict and no further claim.
2. For each gate id in the manifest, set a disposition: `passed`, `deferred` with the reason and the owner, or `no evidence`. A deferred gate must have both a reason and an owner in the QA report or the manifest. Anything else is no evidence.
3. If any gate is no evidence, the verdict is not ready. Name that gate.
4. Read the production settings names from `.env.example` and the image environment in `docs/runbooks/supply-chain.md`. If `AUTH_MODE` is `development` and `NODE_ENV` is `production`, the verdict is not ready. The blocking reason names the development adapter.
5. List open decisions. Include ADR 0002 (no roles or permissions; extension point `apps/api/src/identity/README.md`) and the flag provider (extension point `apps/api/src/index.ts`). Mark whether this build touches that extension point.
6. If this build needs a decision that none of the Inputs files record, the handoff document is required. If the handoff document is not linked from AGENTS.md, the verdict is not ready. Name `AGENTS.md`. Do not invent a handoff path. If `AGENTS.md` does link one, list every decision in it with its extension point.
7. When every gate is passed or deferred with a reason and an owner, the development adapter is not selected for production, and step 6 does not block, the verdict is ready. List the deferrals.
8. Write the report to `quality/evidence/<slug>-readiness.md` when a brief names a slug. Show this verdict to the person. Leave the QA verdict in `quality/evidence/<slug>.md`.

The verdict is `ready` or `not ready`. There is no third verdict.

## Outputs

A readiness report with these parts:

- Verdict (`ready` or `not ready`)
- Blocking reasons (gate names with no evidence; development adapter selected for production; handoff document is not linked from AGENTS.md)
- Gate dispositions (`passed`, `deferred` with reason and owner, or `no evidence`)
- Deferrals
- Open decisions (decision, extension point, touched by this build: yes or no)
- Sources read

One row of the disposition table, as the column shape. The report itself has one row per manifest gate:

| Gate | Disposition |
| ---- | ----------- |
| unit | passed      |

The report contains no secrets and no identity values.

## Review checklist

Mark each item yes, no, or not applicable. A no is a failure.

| Item                                                                          | Evidence source       | Met? (yes, no, not applicable) |
| ----------------------------------------------------------------------------- | --------------------- | ------------------------------ |
| Ready means every gate passed or was deferred with reason and owner (INT-R01) | The disposition table |                                |
| A gate with no evidence is named and the verdict is not ready (INT-R02)       | Blocking reasons      |                                |
| Open decisions are listed, or the missing handoff link blocks ready (INT-R03) | Open decisions        |                                |
| The report does not run the pipeline or deploy (INT-R04)                      | The report text       |                                |
| Gates were not re-run (INT-R05)                                               | Sources read          |                                |
| The report has no secrets or identity values (INT-R06)                        | The report text       |                                |

## Stop conditions

Stop and report not ready. Do not guess, and do not claim ready.

- `quality/quality-manifest.json` cannot be read. Name the path.
- The QA evidence report cannot be read. Name it as missing. Every gate is then no evidence.
- The build needs a decision that none of the Inputs files record, and the handoff document is not linked from AGENTS.md. Name `AGENTS.md`. Do not invent a handoff path.

## Boundaries

- Do not run the pipeline.
- Do not deploy.
- Do not re-run quality gates. The QA skill owns execution.
- Do not add roles, permissions, or a user list.
- Do not claim ready when any required gate lacks evidence.
- Do not claim ready when `AUTH_MODE` is `development` and `NODE_ENV` is `production`.
