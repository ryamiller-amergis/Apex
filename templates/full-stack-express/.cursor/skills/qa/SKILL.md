---
name: qa
description: Reads the quality manifest and the NFR manifest, runs or reviews every gate, and writes an evidence report. A deferred gate or a gate that cannot run is not verified. Use after a change is ready to check, and before the integration skill.
---

# QA

## Purpose

The QA skill serves QA, or a QA agent acting for one. It checks a build against every gate in the quality manifest and reports evidence, including deferrals. The verdict is verified only when every gate passed. The integration skill writes the status the person sees.

## When to use

Use this skill when a change is ready to check. Do not use it to write new tests for a project-specific feature, and do not use it for manual exploratory testing. Do not use it to decide pipeline readiness. The integration skill does that.

## Inputs

Read these before the report. Stop if the quality manifest or the NFR manifest cannot be read.

- [Quality manifest](../../../quality/quality-manifest.json) (`quality/quality-manifest.json`)
- [NFR manifest](../../../quality/nfr-manifest.json) (`quality/nfr-manifest.json`)
- [Quality guide](../../../quality/README.md) (`quality/README.md`)
- [NFR schema](../../../quality/nfr-manifest.schema.json) (`quality/nfr-manifest.schema.json`)
- [Testing guide](../../../docs/testing.md) (`docs/testing.md`)
- [Build artifacts](../../../docs/plans/README.md) (`docs/plans/README.md`)

Gate scripts are the `script` values in the quality manifest. Run each with `pnpm run` and that script name. Do not hard-code a script name in the report in place of the gate id.

## Required references

The Inputs list is the required set. The manifest validator is the command in the Commands table of `quality/README.md` (`pnpm quality:validate`). Run that command before any gate. If it fails, or a gate's script is missing from the root `package.json`, the result is a manifest error and the skill stops.

## Rules

The Enforced by cell is a gate id from `quality/quality-manifest.json`, or `Review`.

| ID     | Rule                                                                                                                                                                             | Enforced by |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| QA-R01 | Run the manifest validator first. A validator failure, or a gate script named by the manifest and missing from the root scripts, is a manifest error. Stop before running gates. | Review      |
| QA-R02 | Run each gate by the script the manifest names, or review it when the environment cannot run it. Record status as passed, failed, not verified, or manifest error.               | Review      |
| QA-R03 | A deferred gate, and a gate that cannot run, is not verified. Record the reason and the owner. Never record it as passed.                                                        | Review      |
| QA-R04 | The verdict is verified only when every gate is passed. A failed gate is named with its output, and the build is not verified.                                                   | Review      |
| QA-R05 | Trace each NFR target to evidence. When `illustrative` is true, report no target supplied. Do not treat the example numbers as a pass.                                           | Review      |
| QA-R06 | The report contains no secrets and no identity values.                                                                                                                           | Review      |

## Procedure

1. Run `pnpm quality:validate`. If it fails, write a manifest error and stop. Do not run gates.
2. Read `quality/quality-manifest.json`. If a gate's `script` is not a script in the root `package.json`, write a manifest error for that gate and stop. Do not run the remaining gates.
3. For each gate, run `pnpm run` with the manifest script, or review the gate when this environment cannot run it (for example a container build with no container runtime). Record the exit status and the first failing output line.
4. A gate listed in `deferrals` with a reason and an owner is not verified. A gate that was not run is not verified. Neither is passed.
5. Read `quality/nfr-manifest.json`. For each target, trace it to the `verifiedBy` evidence. When `illustrative` is true, the status is no target supplied.
6. Set the verdict. The verdict is `verified` only when every gate is `passed`. Otherwise the verdict is `not verified`.
7. Write the report to `quality/evidence/<slug>.md` when a brief names a slug. The integration skill reads this file and writes the status the person sees.

The report lists each gate. Use the manifest id in the Gate column. One shape example, not a substitute for the full list:

| Gate | Script    | Status | Evidence | Reason and owner |
| ---- | --------- | ------ | -------- | ---------------- |
| unit | test:unit | passed | exit 0   |                  |

Replace that row with one row per gate in the manifest. `test:unit` above is the `script` field of the `unit` gate, copied from the manifest, not a hard-coded substitute for the id.

## Outputs

An evidence report with these parts:

- Manifest validation result
- Gate table with columns Gate, Script, Status (`passed`, `failed`, `not verified`, or `manifest error`), Evidence (exit status and the first failing output line), and Reason and owner
- NFR trace table with columns Target, Evidence, and Status
- Verdict: `verified` or `not verified`

A failed gate is named in the table with its output. The verdict is not verified.

A deferred gate lists the reason and the owner from the manifest, with status not verified.

The report contains no secrets and no identity values.

## Review checklist

Mark each item yes, no, or not applicable. A no is a failure.

| Item                                                     | Evidence source         | Met? (yes, no, not applicable) |
| -------------------------------------------------------- | ----------------------- | ------------------------------ |
| The manifest validator ran first (QA-R01)                | `pnpm quality:validate` |                                |
| Every gate has a status and evidence (QA-R02)            | The gate table          |                                |
| Deferred and unrun gates are not verified (QA-R03)       | Reason and owner column |                                |
| A failure is not a verified build (QA-R04)               | The verdict             |                                |
| Illustrative NFR targets say no target supplied (QA-R05) | The NFR trace table     |                                |
| The report has no secrets or identity values (QA-R06)    | The report text         |                                |

## Stop conditions

Stop and report the problem. Do not guess. Do not run later gates after a manifest error.

- `quality/quality-manifest.json` or `quality/nfr-manifest.json` cannot be read. Name the path.
- `pnpm quality:validate` fails. The report says manifest error and stops.
- A gate script named by the manifest is missing. The report flags a manifest error and stops.

## Boundaries

- Do not write new tests for a project-specific feature.
- Do not do manual exploratory testing.
- Do not decide that a build is ready for a pipeline. The integration skill does that.
- Do not treat a deferred gate as passed.
- Do not set an execution tier or a schedule. The manifests define none.
