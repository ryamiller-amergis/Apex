---
name: build-qa
description: Verifies owned integration, accessibility, non-functional, and end-to-end requirements and quality gates for a build task, records red/green or deferred evidence, and emits a versioned apex-evidence block.
disable-model-invocation: true
---

# Build QA

## Purpose

The `build-qa` skill serves the QA role in a Build from prompt run. It verifies user-facing, integration, accessibility (`WCAG 2.1 AA`), non-functional (`NFR-*`), and end-to-end (`e2e`) requirements assigned to a `qa`-role build task, runs the quality manifest gates (`typeCheck`, `lint`, `relatedTests`), and emits a versioned `apex-evidence` block. A deferred gate or an unobservable environment requirement is recorded with an explicit deferral reason and never marked as passed without execution.

## When to use

Use this skill when executing a `qa`-role task in a Build from prompt plan. Do not use it to author product features (`build-implementer` owns feature implementation) or to run the post-merge integration branch check (`build-check` / `build-final-check` owns that).

## Inputs

Read these from the task envelope and repository before running checks or authoring tests:

- **Task key and attempt number**: `taskKey` and `attemptNumber`.
- **Owned requirement IDs**: `AC-*`, `DOD-*`, `BR-*`, and `NFR-*` items assigned to this QA task, with their requirement text and test tier (`unit`, `integration`, or `e2e`).
- **Owned risk decisions**: `RD-*` items assigned to this QA task, if any.
- **Owned files**: repository-relative test and verification file paths this task may create or edit.
- **Reuse list**: existing test harnesses, fixtures, page objects, and helpers (`path`, `symbol`, `reason`).
- **Quality manifest commands**:
  - `typeCheck`: the type-check command to run.
  - `lint`: the lint command to run.
  - `relatedTests`: the related-test command template (substitute changed files into `{files}` when present).
- **Standards contract paths**:
  - `designSystemFile`: design-system file path and content hash.
  - `codingRules`: coding rules path and content hash.
  - `codeMap`: repository code map path and content hash.
- **Prior attempt violations** (when `attemptNumber > 1`): coded violations (`code` and `requirementId`) from the refused attempt that must be resolved.

## Rules

| ID     | Rule                                                                                                                                                                                                    | Enforced by                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| QA-R01 | Every owned requirement (`AC-*`, `DOD-*`, `BR-*`, `NFR-*`) and risk decision (`RD-*`) must have a committed test reference in `ownedFiles` whose test name starts with the ID.                          | Verification evidence check |
| QA-R02 | Observable `unit` and `integration` requirements require a failing test commit (`test(<ID>): <summary>`) followed by a passing commit (`feat(<ID>): <summary>`) with distinct SHAs.                     | Verification evidence check |
| QA-R03 | A requirement may be deferred only when its tier is `e2e` or its kind is `nfr` and the runtime environment cannot execute it (for example no browser binary or live target). Never record a deferred check as passed. | Verification evidence check |
| QA-R04 | Even when an `e2e` or `nfr` requirement is deferred, commit the test file with a valid `testReferences` entry, set `red: null` and `green: null`, and provide a non-empty `deferral.reason`.             | Verification evidence check |
| QA-R05 | Verify UI states (loading, empty, error, loaded), keyboard navigation, visible labels, and `data-testid` selectors against the design-system file and coding rules.                                    | Standards review            |
| QA-R06 | Run `typeCheck`, `lint`, and `relatedTests` from the quality manifest and confirm each exits with `0` before finishing.                                                                                 | Verification evidence check |
| QA-R07 | Never include secrets, bearer tokens, connection strings, or personal identity values in test fixtures, logs, or the `apex-evidence` block. Use synthetic `example.test` values.                        | Redaction & evidence check  |

## Procedure

1. **Ground in the repository**: Read the frozen `designSystemFile`, `codingRules`, `codeMap`, and the task's `reuse` list. Reuse existing test helpers, fixtures, and page objects.
2. **Author and run verification tests per owned requirement**:
   - For each owned `unit` or `integration` requirement (and any executable `e2e` or `nfr` requirement):
     1. Write a test whose name begins with the requirement ID (for example `AC-2: announces error alert and keeps form values on save failure`).
     2. Run the test against the unverified state or assertion target to capture the failing (`red`) run, and commit as `test(<ID>): <summary>`.
     3. Complete the verification harness or fix so the test passes (`exitCode: 0`), commit on a distinct commit as `feat(<ID>): <summary>`, and record the passing (`green`) run.
   - For an `e2e` or `nfr` requirement that cannot run in the current environment:
     1. Author and commit the syntactic test spec in an owned test file with a `testReferences` entry naming the requirement ID.
     2. Record `red: null`, `green: null`, and `deferral: { "reason": "<concrete environment reason>" }`.
3. **Run quality manifest gates**:
   - Execute `typeCheck`, `lint`, and `relatedTests` from the quality manifest.
   - Fix any type, lint, or test regressions introduced in owned files and re-run until all three exit with `0`.
4. **Complete the standards review**:
   - Check all authored test files against the coding rules and design-system selector conventions (`data-testid`, accessible roles, synthetic test data).
   - Set `standardsReview: { "completed": true, "findings": [] }`.
5. **Emit the `apex-evidence` block**:
   - End the final message with one fenced `apex-evidence` JSON block (`version: 1`).

## Outputs

- Committed test files inside `ownedFiles` covering every owned requirement and risk decision.
- Passing `typeCheck`, `lint`, and `relatedTests` runs.
- A final fenced `apex-evidence` JSON block in the closing message.

## Review checklist

| Item                                                                                  | Evidence source                        | Met? (yes, no, not applicable) |
| ------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------ |
| Every owned requirement has a `testReferences` entry in `ownedFiles` (QA-R01)         | `entries[].testReferences`             |                                |
| Executable requirements have distinct `red` and `green` commits (QA-R02)              | `entries[].red` and `entries[].green`  |                                |
| Deferred items are strictly `e2e` or `nfr` with a concrete `deferral.reason` (QA-R03, QA-R04) | `entries[].deferral`           |                                |
| Loading, empty, error, loaded states and accessibility selectors verified (QA-R05)    | Test assertions                        |                                |
| `typeCheck`, `lint`, and `relatedTests` exited with `0` (QA-R06)                      | `checks` object                        |                                |
| Test data uses synthetic values with no secrets or real identities (QA-R07)           | Diff and `apex-evidence`               |                                |

## Stop conditions

- A required standards contract file (`designSystemFile`, `codingRules`, `codeMap`) cannot be read.
- A `unit` or `integration` acceptance criterion (`AC-*`, `DOD-*`, `BR-*`) or risk decision (`RD-*`) cannot be tested without modifying files outside `ownedFiles`.

## Boundaries

- Do not mark a deferred or unrun test as passed.
- Do not modify application source files outside `ownedFiles`.
- Do not open or complete a pull request.
- Do not trigger deployment pipelines.

## Example `apex-evidence` block

```apex-evidence
{
  "version": 1,
  "taskKey": "t-qa-1",
  "attemptNumber": 1,
  "entries": [
    {
      "requirementId": "AC-2",
      "tier": "integration",
      "testReferences": [
        {
          "file": "src/client/components/__tests__/ProfileForm.a11y.test.tsx",
          "name": "AC-2: announces validation alert and preserves input on error"
        }
      ],
      "red": {
        "commit": "112233a",
        "command": "npx jest src/client/components/__tests__/ProfileForm.a11y.test.tsx",
        "exitCode": 1,
        "failedTests": ["AC-2: announces validation alert and preserves input on error"],
        "output": "FAIL src/client/components/__tests__/ProfileForm.a11y.test.tsx\n  ● AC-2: announces validation alert and preserves input on error"
      },
      "green": {
        "commit": "445566b",
        "command": "npx jest src/client/components/__tests__/ProfileForm.a11y.test.tsx",
        "exitCode": 0,
        "passedTests": ["AC-2: announces validation alert and preserves input on error"],
        "output": "PASS src/client/components/__tests__/ProfileForm.a11y.test.tsx\n  ✓ AC-2: announces validation alert and preserves input on error"
      },
      "deferral": null
    },
    {
      "requirementId": "NFR-1",
      "tier": "e2e",
      "testReferences": [
        {
          "file": "tests/e2e/specs/profile-flow.spec.ts",
          "name": "NFR-1: completes profile update flow in browser"
        }
      ],
      "red": null,
      "green": null,
      "deferral": {
        "reason": "Playwright browser binaries and live environment are not provisioned in the task container"
      }
    }
  ],
  "checks": {
    "typeCheck": {
      "command": "npx tsc --noEmit",
      "exitCode": 0
    },
    "lint": {
      "command": "npx eslint src --ext .ts,.tsx",
      "exitCode": 0
    },
    "relatedTests": {
      "command": "npx jest --findRelatedTests src/client/components/__tests__/ProfileForm.a11y.test.tsx",
      "exitCode": 0
    }
  },
  "standardsReview": {
    "completed": true,
    "findings": []
  },
  "escalation": null
}
```
