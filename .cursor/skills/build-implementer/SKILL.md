---
name: build-implementer
description: Implements one complete prompted feature in a repository-agent run. Searches before creating code, plans internally without pausing, uses a focused red commit followed by a green implementation commit, runs and repairs the quality checks, and emits structured evidence for every requirement.
disable-model-invocation: true
---

# Build Implementer

## Purpose

The `build-implementer` skill performs the complete repository change for a Build from prompt run. It plans internally, reads the standards contract before writing code, implements every owned requirement (`AC-*`, `DOD-*`, `BR-*`, `NFR-*`) and risk decision (`RD-*`), runs and repairs the quality checks, reviews the resulting diff, and emits a versioned `apex-evidence` block for evaluation and future training.

## When to use

Use this skill for the single repository-agent step after the requester confirms the scope. Do not stop to show or request approval for an internal technical plan. Stop only when a listed stop condition prevents a safe implementation.

## Inputs

The per-task envelope supplies these inputs. Read the repository files before the first edit:

- **Task key and attempt number**: `taskKey` and `attemptNumber`.
- **Classification and branches**: `small` or `full`, the integration branch name, the task branch name, and `planPath` (used when escalating from the `small` path).
- **Owned requirement IDs**: `AC-*`, `DOD-*`, `BR-*`, and `NFR-*` items assigned to this task, with their requirement text and test tier (`unit`, `integration`, or `e2e`). Retired requirements are excluded and need no test.
- **Owned risk decisions**: `RD-*` items assigned to this task, with their risk constraint text.
- **Owned files**: repository-relative file paths this task may create or edit (`null` on the `small` path). Every test reference file must be a repository-relative path inside the task's owned files.
- **Reuse list**: existing components, hooks, services, and helpers identified during planning (`path`, `symbol`, `reason`).
- **Quality manifest commands**:
  - `typeCheck`: the type-check command to run.
  - `lint`: the lint command to run.
  - `relatedTests`: the related-test command template (substitute changed files into `{files}` when present).
- **Standards contract paths**:
  - `designSystemFile`: design-system file path and content hash.
  - `codingRules`: coding rules path and content hash.
  - `codeMap`: repository code map path and content hash.
- **Prior attempt violations** (when `attemptNumber > 1`): coded violations (`code` and `requirementId`) from the refused attempt that must be fixed in this attempt.

## Rules

| ID      | Rule                                                                                                                                                                                                 | Enforced by                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| IMP-R01 | Search the code map, the reuse list, and the repository before creating any new component, hook, service, or helper. Reuse existing modules whenever they fit.                                       | Standards review             |
| IMP-R02 | Add focused failing tests for the owned requirements, commit them together as `test(build): <summary>`, then commit the passing implementation separately as `feat(build): <summary>`.               | Verification evidence check  |
| IMP-R03 | Every owned requirement and risk decision must map to a named test and to the red and green commits; related requirements may share the same commit pair.                                               | Verification evidence check  |
| IMP-R04 | Run the quality manifest commands (`typeCheck`, `lint`, `relatedTests`), fix breaks in-session, and report only the final passing run (`exitCode: 0`) so in-session fixes use zero repair attempts. | Verification evidence check  |
| IMP-R05 | Review the diff against the frozen standards contract (`design-system`, `coding rules`, `code map`) for duplicated helpers, hard-coded colours, off-library components, and missing accessibility.   | Standards review             |
| IMP-R06 | Never put a hard-coded secret, bearer token, connection string, or personal identity value in code, tests, commit messages, or evidence output.                                                      | Redaction & evidence check   |
| IMP-R07 | On the `small` path, if the feature requires more than two tasks, a database migration, or a high-risk decision, keep the committed red tests on the branch, write the full plan to `planPath`, and escalate. | Small-path escalation check |

## Procedure

1. **Search before creating**: Read the code map, coding rules, design-system file, and reuse list, and search the repository before creating any new component, hook, service, or helper.
2. **Create one focused red test set**:
   - Write named tests for every owned requirement and risk decision. Test names begin with their IDs.
   - Run the focused tests and confirm the relevant assertions fail for the missing behavior.
   - Commit the test set once as `test(build): <summary>` and record that commit and final red output for each covered ID.
3. **Implement the complete feature**:
   - Reuse repository patterns and shared components wherever they fit.
   - Implement the smallest coherent change that makes the focused test set pass.
   - Commit the implementation separately as `feat(build): <summary>`. The red and green commit SHAs must differ.
4. **Verify every requirement**:
   - Run the focused tests again and map each owned requirement and risk decision to its named passing test and the shared red/green commit pair.
5. **Run quality manifest checks (`typeCheck`, `lint`, `relatedTests`)**:
   - Run the manifest's `typeCheck` command, `lint` command, and `relatedTests` command (replacing `{files}` with the changed files).
   - If any check or related test fails because of your change, fix the break inside the current session and re-run until `typeCheck`, `lint`, and `relatedTests` all exit with `0`.
   - Record only the final passing run of each check in `checks.typeCheck`, `checks.lint`, and `checks.relatedTests`.
6. **Review against the standards contract**:
   - Read the frozen standards contract files (design-system file, coding rules, and code map) and check the diff against [standards-review.md](../build-final-check/standards-review.md).
   - Fix every finding before finishing, then set `standardsReview: { "completed": true, "findings": [] }`.
7. **Emit the `apex-evidence` block**:
   - End your final message with one fenced `apex-evidence` JSON block matching version `1`.
   - Keep each `red.output` and `green.output` string to at most the last 100 KB.

## Deferral rule

A requirement may be deferred only when its tier is `e2e` or its kind is `nfr` and the test environment cannot observe it during the task run. Even when deferred, you must still commit the test file and include a valid `testReferences` entry, set `deferral: { "reason": "<non-empty explanation>" }`, and set `red: null` and `green: null`. Unit and integration acceptance criteria (`AC-*`, `DOD-*`, `BR-*`) and risk decisions (`RD-*`) may never be deferred.

## Small-path escalation rule

When running on the `small` path, if you find that the feature requires more than two tasks, a database migration, or a high-risk decision:

1. Stop before making green implementation commits.
2. Keep the committed red tests on the integration branch so the red tests carry over to the full build path.
3. Write the full build plan JSON to the `planPath` given in the task envelope.
4. Emit the `apex-evidence` block with `escalation: { "reason": "<why the work exceeds the small path>", "planPath": "<planPath from the envelope>" }` and include the committed `red` evidence entries so Apex switches the run to the full path and preserves the red tests.

## Review checklist

| Item                                                                                     | Evidence source                       | Met? (yes, no, not applicable) |
| ---------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------ |
| Searched code map and reuse list before creating new modules (IMP-R01)                   | Commit diff and reuse list            |                                |
| Every owned requirement maps to a named red/green test and a distinct red/green commit pair (IMP-R02) | `entries[].red` and `entries[].green` |                                |
| Every owned risk decision (`RD-*`) maps to evidence; related IDs may share a commit pair (IMP-R03) | `entries[]` for `RD-*`                |                                |
| `typeCheck`, `lint`, and `relatedTests` exited with `0` (IMP-R04)                        | `checks` object                       |                                |
| Standards contract reviewed with zero open findings (IMP-R05)                            | `standardsReview`                     |                                |
| No secrets, tokens, or personal identity values appear in code or output (IMP-R06)       | Diff and `apex-evidence`              |                                |

## Stop conditions

- A required standards contract file cannot be read.
- The task requires editing a file outside `ownedFiles` on the `full` path.
- On the `small` path, the work exceeds two tasks, needs a migration, or introduces a high-risk decision — stop after committing red tests and emit the `escalation` block.

## Boundaries

- Do not open or complete a pull request.
- Do not modify files outside `ownedFiles` when `ownedFiles` is set.
- Do not delete, skip, or weaken an existing test to make a check pass.

## Example `apex-evidence` block

```apex-evidence
{
  "version": 1,
  "taskKey": "t-impl-1",
  "attemptNumber": 1,
  "entries": [
    {
      "requirementId": "AC-1",
      "tier": "unit",
      "testReferences": [
        {
          "file": "src/services/__tests__/titleValidator.test.ts",
          "name": "AC-1: rejects an empty title"
        }
      ],
      "red": {
        "commit": "a1b2c3d",
        "command": "npx jest src/services/__tests__/titleValidator.test.ts",
        "exitCode": 1,
        "failedTests": ["AC-1: rejects an empty title"],
        "output": "FAIL src/services/__tests__/titleValidator.test.ts\n  ● AC-1: rejects an empty title"
      },
      "green": {
        "commit": "d4e5f6a",
        "command": "npx jest src/services/__tests__/titleValidator.test.ts",
        "exitCode": 0,
        "passedTests": ["AC-1: rejects an empty title"],
        "output": "PASS src/services/__tests__/titleValidator.test.ts\n  ✓ AC-1: rejects an empty title"
      },
      "deferral": null
    },
    {
      "requirementId": "RD-1",
      "tier": "unit",
      "testReferences": [
        {
          "file": "src/services/__tests__/titleValidator.test.ts",
          "name": "RD-1: preserves existing records on validation failure"
        }
      ],
      "red": {
        "commit": "b2c3d4e",
        "command": "npx jest src/services/__tests__/titleValidator.test.ts",
        "exitCode": 1,
        "failedTests": ["RD-1: preserves existing records on validation failure"],
        "output": "FAIL src/services/__tests__/titleValidator.test.ts\n  ● RD-1: preserves existing records on validation failure"
      },
      "green": {
        "commit": "e5f6a7b",
        "command": "npx jest src/services/__tests__/titleValidator.test.ts",
        "exitCode": 0,
        "passedTests": ["RD-1: preserves existing records on validation failure"],
        "output": "PASS src/services/__tests__/titleValidator.test.ts\n  ✓ RD-1: preserves existing records on validation failure"
      },
      "deferral": null
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
      "command": "npx jest --findRelatedTests src/services/titleValidator.ts",
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
