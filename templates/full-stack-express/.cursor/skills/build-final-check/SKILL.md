---
name: build-final-check
description: Runs the combined final check, standards review, or default-branch sync on a build's integration branch and emits a structured apex-final-check-report readiness block.
disable-model-invocation: true
---

# Build Final Check and Standards Review

## Purpose

The `build-final-check` skill serves the Check (Integration & Standards Readiness) role in a Build from prompt run. After all task branches have merged into the integration branch on the full path, it reads the frozen standards contract, runs every quality manifest gate (`unit_full`, `unit_related`, `type_check`, `lint`), verifies contract/route consistency (`corepack pnpm openapi:check` and `corepack pnpm routes:check`), reviews the combined diff against the standards checklist, repairs combined breaks when repair budget remains, and emits a fenced `apex-final-check-report` block. In `sync` mode (at Accept time), it merges the repository's default branch into the integration branch, runs the full unit suite, and pushes the synced branch.

## When to use

Use this skill for the `check` role in a project's Build profile (`final-check` mode after task merges, or `sync` mode when accepting a preview whose default branch has moved). Do not use it to deploy or to complete a pull request into the default branch.

## Inputs

Read these inputs from the prompt and the repository before running checks:

- **Integration branch and base commit**: the build's integration branch (`apex/build/<runId>`) and `baseCommit`.
- **Quality manifest commands**:
  - `unit_full`: full unit test suite command (`corepack pnpm test:unit`).
  - `unit_related`: related tests command for all files changed since `baseCommit` (`corepack pnpm vitest related --run {files}`).
  - `type_check`: TypeScript type-check command (`corepack pnpm typecheck`).
  - `lint`: linter command (`corepack pnpm lint`).
- **Frozen standards contract** (read these three files first):
  - `designSystemFile`: design-system file path and content hash (`.cursor/skills/design-system/SKILL.md`).
  - `codingRules`: coding rules path and content hash (`.cursor/rules/react-mui-express.mdc`).
  - `codeMap`: repository code map path and content hash (`.cursor/CODEMAP.md`).
- **Context notes**: `contextNotesPath` containing the plan overview, task ownership, reuse list, and risk constraints.
- **Repair budget**: `repairAttemptsLeft` (`0`, `1`, or `2`) and optional `Prior Check Report Summary`.

## Rules

| ID      | Rule                                                                                                                                                                                                 | Enforced by          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| CHK-R01 | Open and read the three frozen standards files (`designSystemFile`, `codingRules`, `codeMap`) before running checks. If any cannot be read, stop and report `status: "unreadable_input"` with its path. | Final check parser   |
| CHK-R02 | Run all four quality manifest gates on the integration branch: **full unit suite** (`unit_full`), **related tests** for changed files (`unit_related`), **type-check** (`type_check`), and **lint** (`lint`). | Final check parser   |
| CHK-R03 | Review the combined diff against the standards contract for `duplicate_helper`, `hard_coded_colour`, `off_library_component` (requires `exceptionReason` when `resolution: "exception"`), and `missing_accessibility`. | Final check parser |
| CHK-R04 | When a check fails and `repairAttemptsLeft > 0`, fix the break on the check branch (for example running `corepack pnpm openapi:generate` if `openapi.json` drifted across merged tasks), set `repairedInSession: true`, and **re-run** all checks. Never delete, skip or weaken a test to pass. | Final check handler |
| CHK-R05 | When `repairAttemptsLeft === 0`, run in **report-only** mode: change no files and set `repairedInSession: false`.                                                                                    | Final check handler  |
| CHK-R06 | Record `validatedCommit` as the 40-character git HEAD SHA of the branch on which the final checks ran.                                                                                               | Final check handler  |
| CHK-R07 | The report contains no secrets, bearer tokens, connection strings, or code excerpts. Free-text summaries and finding details are plain text (at most 500 characters).                                | Redaction & parser   |

## Mode: `final-check`

Follow these steps in order:

1. **Read the three standards files first**:
   - Open the frozen `designSystemFile`, `codingRules`, and `codeMap` paths supplied in the prompt.
   - If any of the three files cannot be read, stop immediately, make no changes, and report `standards: { "status": "unreadable_input", "path": "<unreadable file path>" }` in your `apex-final-check-report` block.
2. **Run the quality manifest checks on the integration branch**:
   - Run the **full unit suite** (`unit_full`).
   - Run the **related tests** for every file changed since the base commit (`unit_related`).
   - Run **type-check** (`type_check`) and **lint** (`lint`).
   - If routes or contracts changed, also verify `corepack pnpm openapi:check` and `corepack pnpm routes:check`.
3. **Review the combined change against the standards contract and reuse list**:
   - Follow [standards-review.md](standards-review.md) for `duplicate_helper`, `hard_coded_colour`, `off_library_component`, and `missing_accessibility`.
4. **Repair policy**:
   - If a check fails and repair budget is left (`repairAttemptsLeft > 0`), fix the code on your branch and set `repairedInSession: true`.
   - Never delete, skip or weaken a test to pass.
   - If no repair budget is left (`repairAttemptsLeft === 0`), run in **report-only** mode and change nothing (`repairedInSession: false`).
   - Always **re-run** the checks after any fix so the reported outcomes reflect the final commit on your branch.
5. **Emit the `apex-final-check-report` block**:
   - End your final message with a fenced `apex-final-check-report` JSON block matching `schemaVersion: 1`.

## Mode: `sync` (Accept default-branch sync)

1. Merge the repository's default branch into the integration branch.
2. Resolve any merge conflicts while preserving the brief's requirements and risk decisions.
3. Run the **full unit suite** (`unit_full`), **type-check**, and **lint**.
4. Push the merged commit to the integration branch and emit the `apex-final-check-report` block with the new `validatedCommit` SHA.

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

```apex-final-check-report
{
  "schemaVersion": 1,
  "validatedCommit": "<40-char git head sha>",
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
  "summary": "All checks and standards review passed."
}
```
