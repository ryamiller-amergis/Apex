---
name: build-check
description: Runs the combined final check, standards review, or default-branch sync on a build's integration branch and emits a structured apex-final-check-report readiness block.
disable-model-invocation: true
---

# Build Check

## Purpose

The `build-check` skill serves the Check (Integration & Standards Readiness) role in a Build from prompt run. After all task branches have merged into the integration branch on the full path, it reads the frozen standards contract, runs every quality manifest gate (`unit_full`, `unit_related`, `type_check`, `lint`), reviews the combined diff against the standards checklist, repairs combined breaks when repair budget remains, and emits a fenced `apex-final-check-report` block. In `sync` mode (at Accept time), it merges the repository's default branch into the integration branch, runs the full unit suite, and pushes the synced branch.

## When to use

Use this skill for the `check` role in a project's Build profile (`final-check` mode after task merges, or `sync` mode when accepting a preview whose default branch has moved). Do not use it to deploy or to complete a pull request into the default branch.

## Inputs

Read these inputs from the prompt and the repository before running checks:

- **Integration branch and base commit**: the build's integration branch (`apex/build/<runId>`) and `baseCommit`.
- **Quality manifest commands**:
  - `unit_full`: full unit test suite command.
  - `unit_related`: related tests command for all files changed since `baseCommit`.
  - `type_check`: TypeScript type-check command.
  - `lint`: linter command.
- **Frozen standards contract** (read these three files first):
  - `designSystemFile`: design-system file path and content hash.
  - `codingRules`: coding rules path and content hash.
  - `codeMap`: repository code map path and content hash.
- **Context notes**: `contextNotesPath` containing the plan overview, task ownership, reuse list, and risk constraints.
- **Repair budget**: `repairAttemptsLeft` (`0`, `1`, or `2`) and optional `Prior Check Report Summary`.

## Rules

| ID      | Rule                                                                                                                                                                                                 | Enforced by          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| CHK-R01 | Open and read the three frozen standards files (`designSystemFile`, `codingRules`, `codeMap`) before running checks. If any cannot be read, stop and report `status: "unreadable_input"` with its path. | Final check parser   |
| CHK-R02 | Run all four quality manifest gates on the integration branch: **full unit suite** (`unit_full`), **related tests** for changed files (`unit_related`), **type-check** (`type_check`), and **lint** (`lint`). | Final check parser   |
| CHK-R03 | Review the combined diff against the standards contract for `duplicate_helper`, `hard_coded_colour`, `off_library_component` (requires `exceptionReason` when `resolution: "exception"`), and `missing_accessibility`. | Final check parser |
| CHK-R04 | When a check fails and `repairAttemptsLeft > 0`, fix the break on the check branch, set `repairedInSession: true`, and **re-run** all checks. Never delete, skip or weaken a test to pass.           | Final check handler  |
| CHK-R05 | When `repairAttemptsLeft === 0`, run in **report-only** mode: change no files and set `repairedInSession: false`.                                                                                    | Final check handler  |
| CHK-R06 | Record `validatedCommit` as the 40-character git HEAD SHA of the branch on which the final checks ran.                                                                                               | Final check handler  |
| CHK-R07 | The report contains no secrets, bearer tokens, connection strings, or code excerpts. Free-text summaries and finding details are plain text (at most 500 characters).                                | Redaction & parser   |

## Procedure

### Mode: `final-check`

1. **Read the three standards files first**:
   - Open `designSystemFile`, `codingRules`, and `codeMap` from the frozen paths.
   - If any of the three files cannot be read, stop immediately, make no changes, and emit the `apex-final-check-report` block with `standards: { "status": "unreadable_input", "path": "<unreadable file path>" }`.
2. **Run the quality manifest checks on the integration branch**:
   - Run the **full unit suite** (`unit_full`).
   - Run the **related tests** for every file changed since the base commit (`unit_related`).
   - Run **type-check** (`type_check`) and **lint** (`lint`).
3. **Review the combined change against the standards contract and reuse list**:
   - Inspect all files changed since `baseCommit` against the four rules in [standards-review.md](../build-final-check/standards-review.md):
     - `duplicate_helper`: replace with the existing helper from the code map or reuse list (`resolution: "fixed"`).
     - `hard_coded_colour`: swap literal colours for design tokens (`resolution: "fixed"`).
     - `off_library_component`: replace with the library's component (`resolution: "fixed"`) or record a justified exception (`resolution: "exception"` with a non-empty `exceptionReason`).
     - `missing_accessibility`: add the missing label, accessible name, or focus handling (`resolution: "fixed"`) or report it (`resolution: "open"`).
4. **Apply repair policy**:
   - If any check fails and repair budget remains (`repairAttemptsLeft > 0`), fix the code, commit the fix, set `repairedInSession: true`, and **re-run** all four quality manifest checks so the reported outcomes reflect the final commit.
   - Never delete, skip or weaken a test to make a check pass.
   - If no repair budget remains (`repairAttemptsLeft === 0`), run in **report-only** mode and change nothing (`repairedInSession: false`).
5. **Emit the `apex-final-check-report` block**:
   - End the final message with a fenced `apex-final-check-report` JSON block (`schemaVersion: 1`).

### Mode: `sync` (Accept default-branch sync)

1. Merge the repository's default branch into the integration branch.
2. Resolve any merge conflicts while preserving the brief's requirements and risk decisions.
3. Run the **full unit suite** (`unit_full`), **type-check**, and **lint**.
4. Push the merged commit to the integration branch and emit the `apex-final-check-report` block with the new `validatedCommit` SHA.

## Outputs

A fenced `apex-final-check-report` JSON block at the end of the final message with:

- `schemaVersion`: `1`
- `validatedCommit`: 40-character git commit SHA verified by the checks
- `repairedInSession`: `true` if commits were made during this session, else `false`
- `checks`: array of `{ kind, outcome, failedTests?, summary }` including at least `unit_full` and `unit_related`
- `standards`: `{ status: "reviewed", findings: [...], reviewSeconds }` or `{ status: "unreadable_input", path }`
- `summary`: plain-text summary (at most 500 characters)

## Review checklist

| Item                                                                                     | Evidence source                  | Met? (yes, no, not applicable) |
| ---------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------ |
| Frozen standards files were read first, or `unreadable_input` was reported (CHK-R01)     | `standards.status`               |                                |
| `unit_full`, `unit_related`, `type_check`, and `lint` were executed (CHK-R02)            | `checks` array                   |                                |
| Combined diff reviewed for all four standards rules (CHK-R03)                            | `standards.findings`             |                                |
| Any `exception` finding includes a non-empty `exceptionReason` (CHK-R03)                 | `standards.findings`             |                                |
| Checks were re-run after any in-session fix without weakening tests (CHK-R04)            | `checks` and git log             |                                |
| Report-only mode respected when `repairAttemptsLeft === 0` (CHK-R05)                     | `repairedInSession: false`       |                                |
| Report contains no secrets, identity values, or code excerpts (CHK-R07)                  | `apex-final-check-report` JSON   |                                |

## Stop conditions

- Any of `designSystemFile`, `codingRules`, or `codeMap` cannot be read — stop immediately, make no edits, and report `standards: { "status": "unreadable_input", "path": "<file path>" }`.
- `repairAttemptsLeft === 0` and a check fails — report the failure in `checks` with `repairedInSession: false` and make no code changes.

## Boundaries

- Do not run a deployment pipeline or deploy the application.
- Do not open, approve, or complete a pull request into the default branch.
- Do not delete, skip, or weaken tests.

## Example `apex-final-check-report` block

```apex-final-check-report
{
  "schemaVersion": 1,
  "validatedCommit": "0123456789abcdef0123456789abcdef01234567",
  "repairedInSession": false,
  "checks": [
    { "kind": "unit_full", "outcome": "passed", "summary": "All unit tests passed" },
    { "kind": "unit_related", "outcome": "passed", "summary": "All related tests passed" },
    { "kind": "type_check", "outcome": "passed", "summary": "Type-check passed" },
    { "kind": "lint", "outcome": "passed", "summary": "Lint passed" }
  ],
  "standards": {
    "status": "reviewed",
    "findings": [],
    "reviewSeconds": 30
  },
  "summary": "All quality gates and standards review checks passed."
}
```
