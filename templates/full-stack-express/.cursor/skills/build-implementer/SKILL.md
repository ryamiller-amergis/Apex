---
name: build-implementer
description: Implements one complete prompted feature in a repository-agent run. Loads api-contract before endpoint edits and ui-standards before screen edits, plans internally, uses a focused red commit followed by a green implementation commit, repairs quality failures, and emits structured evidence.
disable-model-invocation: true
---

# Build Implementer

## Purpose

The `build-implementer` skill performs the complete repository change for a Build from prompt run. It plans internally, reads the standards contract and domain skills before writing code, implements every owned requirement and risk decision, repairs quality failures in-session, reviews the resulting diff, and emits structured evidence for evaluation and future training.

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
  - `typeCheck`: the type-check command to run (`corepack pnpm typecheck`).
  - `lint`: the lint command to run (`corepack pnpm lint`).
  - `relatedTests`: the related-test command template (`corepack pnpm vitest related --run {files}`).
- **Standards contract paths**:
  - `designSystemFile`: design-system file path and content hash (`.cursor/skills/design-system/SKILL.md`).
  - `codingRules`: coding rules path and content hash (`.cursor/rules/react-mui-express.mdc`).
  - `codeMap`: repository code map path and content hash (`.cursor/CODEMAP.md`).
- **Domain skills & reference slices** (read before editing):
  - `.cursor/skills/api-contract/SKILL.md` and `packages/contracts/src/routes/me.ts` — **mandatory** when the task adds or changes an HTTP endpoint or contract schema.
  - `.cursor/skills/ui-standards/SKILL.md`, `.cursor/skills/product-quality/SKILL.md`, `docs/component-catalog.md`, and `apps/web/src/features/profile/ProfileForm.tsx` — **mandatory** when the task adds or changes a screen or UI component.
  - `docs/feature-slices.md` and `docs/runbooks/migrations.md` — when adding a feature slice or schema migration.
- **Prior attempt violations** (when `attemptNumber > 1`): coded violations (`code` and `requirementId`) from the refused attempt that must be fixed in this attempt.

## Rules

| ID      | Rule                                                                                                                                                                                                                          | Enforced by                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| IMP-R01 | Search the code map, the reuse list, and the repository before creating any new component, hook, service, or helper. Reuse existing modules (`@project-scope/ui`, `@project-scope/contracts`, `apiClient`) whenever they fit. | Standards review            |
| IMP-R02 | Add focused failing tests for the owned requirements, commit them together as `test(build): <summary>`, then commit the passing implementation separately as `feat(build): <summary>`.                                        | Verification evidence check |
| IMP-R03 | Every owned requirement and risk decision must map to a named test and to the red and green commits; related requirements may share the same commit pair.                                                                     | Verification evidence check |
| IMP-R04 | Run the quality manifest commands (`typeCheck`, `lint`, `relatedTests`), fix breaks in-session, and report only the final passing run (`exitCode: 0`) so in-session fixes use zero repair attempts.                           | Verification evidence check |
| IMP-R05 | Review the diff against the frozen standards contract (`design-system`, `coding rules`, `code map`), `.cursor/skills/api-contract/SKILL.md` (for endpoints), and `.cursor/skills/ui-standards/SKILL.md` (for screens).        | Standards review            |
| IMP-R06 | Never put a hard-coded secret, bearer token, connection string, or personal identity value in code, tests, commit messages, or evidence output. Use synthetic `example.test` values.                                          | Redaction & evidence check  |
| IMP-R07 | Implement the complete feature end-to-end in this session — including database migrations, Zod contracts, API routes, and UI screens. Never stop after red tests or write a `plan.json` escalation file.                      | Verification evidence check |

## Runtime

Cursor cloud machines ship Node 22 and ignore `.nvmrc`. Before any install, type-check, lint, or test command, read `package.json` `engines.node` and `.nvmrc`. If `node -v` does not satisfy that range, install the required major version and put its `node`, `npm`, and `pnpm` first on `PATH`, ahead of `/exec-daemon`. Then install dependencies. Never lower `engines.node` to silence an engine error. If the required Node version cannot be installed, stop and say which version the repository requires and which version is installed. Do not commit a partial feature.

## Procedure

1. **Search and load domain skills before creating**:
   - Read the code map, coding rules, design-system file, and reuse list.
   - If the task touches an API endpoint or contract schema, read `.cursor/skills/api-contract/SKILL.md`: define the route in `packages/contracts/src/routes/`, register it in `packages/contracts/src/registry.ts`, regenerate `packages/contracts/openapi/openapi.json` via `corepack pnpm openapi:generate` (when in `ownedFiles` or on the `small` path), use `getPrincipal`, and return RFC 9457 Problem Details.
   - If the task touches a screen or UI component, read `.cursor/skills/ui-standards/SKILL.md`: use `@project-scope/ui` (`LoadingState`, `EmptyState`, `ErrorState`, `testId(scope, ...parts)`), `react-hook-form` + `zodResolver`, `createAppQueryClient` + query invalidation, and zero hard-coded colours (`theme.vars.palette.*`, `theme.spacing(n)`).
2. **Create one focused red test set**:
   - Write named tests for every owned requirement and risk decision. Test names begin with their IDs.
   - Run the focused tests and confirm the relevant assertions fail for the missing behavior.
   - Commit the test set once as `test(build): <summary>`, push to `origin` (`git push -u origin <targetBranch>`), and record that commit and final red output for each covered ID.
3. **Implement the complete feature**:
   - Reuse repository patterns and shared components wherever they fit.
   - Implement the complete end-to-end change that makes the focused test set pass.
   - Commit the implementation separately as `feat(build): <summary>` and immediately push to `origin` (`git push -u origin <targetBranch>`). The red and green commit SHAs must differ.
4. **Verify every requirement**:
   - Run the focused tests again and map each requirement and risk decision to its named passing test and the shared red/green commit pair.
   - Do not go on while any owned id lacks a passing test. A requirement that cites two test files needs a passing run for each file.
5. **Run quality manifest checks (`typeCheck`, `lint`, `relatedTests`)**:
   - Run the manifest's `typeCheck` command, `lint` command, and `relatedTests` command (replacing `{files}` with the changed files).
   - If any check or related test fails because of your change, fix the break inside the current session, commit and `git push` the fix, and re-run until `typeCheck`, `lint`, and `relatedTests` all exit with `0`.
   - Record only the final passing run of each check in `checks.typeCheck`, `checks.lint`, and `checks.relatedTests`.
6. **Review against the standards contract**:
   - Read the frozen standards contract files (design-system file, coding rules, and code map) and check the diff against [standards-review.md](../build-final-check/standards-review.md).
   - Fix every finding before finishing, then set `standardsReview: { "completed": true, "findings": [] }`.
7. **Visual self-review (UI work)**:
   - Verify responsive layout, hierarchy, and theme tokens with fast Vitest component tests (`corepack pnpm test:unit`). Do **not** launch a live Vite dev server or run `playwright test` inside the cloud container (which stalls without a live backend/database and risks hitting the container timeout).
   - Commit the Playwright visual snapshot spec file (`apps/web/e2e/*.spec.ts`) and, for any Playwright visual snapshot requirement (`DOD-*`), record it in `apex-evidence` using the `e2e` deferral rule (`"tier": "e2e"`, `"deferral": { "reason": "Playwright browser snapshots deferred to CI; verified via Vitest component tests." }`, `"red": null`, `"green": null`).
   - Prefer `PageHeader`, `ContentSurface`, catalog components, and `@mui/x-date-pickers` when appropriate; record reuse rationale.
   - Set `visualReview: { "completed": true, "findings": [], "screenshotPaths": ["..."], "componentReuseRationale": "..." }`.
8. **Emit the `apex-evidence` block only when every owned check passes**:
   - Do not end the turn, and do not say the task is finished, until every owned requirement and risk decision is covered.
   - One entry per owned id. For an entry that is not an allowed e2e deferral, `green.exitCode` is `0` and every `testReferences[].name` appears in `green.passedTests` from the command that ran that test file. A filtered command that lists one test does not cover a second cited file.
   - `checks.typeCheck`, `checks.lint`, and `checks.relatedTests` each record exit code `0`.
   - If any owned id is missing, or any cited test is absent from `passedTests`, keep working. Do not emit the block.
   - When the gate passes, end your final message with one fenced `apex-evidence` JSON block matching version `1`.
   - Keep each `red.output` and `green.output` string to at most the last 100 KB.

## Deferral rule

A requirement may be deferred only when its tier is `e2e` or its kind is `nfr` and the test environment cannot observe it during the task run. Even when deferred, you must still commit the test file and include a valid `testReferences` entry, set `deferral: { "reason": "<non-empty explanation>" }`, and set `red: null` and `green: null`. Unit and integration acceptance criteria (`AC-*`, `DOD-*`, `BR-*`) and risk decisions (`RD-*`) may never be deferred.

## Full-stack execution rule

You own the **entire feature end-to-end** — database schema/migrations, Zod contracts, OpenAPI regeneration, backend API routes, frontend screens, and tests. Always implement the complete green feature in this session and set `"escalation": null` in `apex-evidence`. Never stop after writing red tests and never defer implementation to a `plan.json` file.

## Stop conditions

- A required standards contract file cannot be read.
- The task requires editing a file outside `ownedFiles` when a non-empty `ownedFiles` list is set.

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
          "file": "apps/web/src/features/profile/__tests__/ProfileForm.test.tsx",
          "name": "AC-1: rejects an empty display name"
        }
      ],
      "red": {
        "commit": "a1b2c3d",
        "command": "corepack pnpm vitest run apps/web/src/features/profile/__tests__/ProfileForm.test.tsx",
        "exitCode": 1,
        "failedTests": ["AC-1: rejects an empty display name"],
        "output": "FAIL apps/web/src/features/profile/__tests__/ProfileForm.test.tsx\n  × AC-1: rejects an empty display name"
      },
      "green": {
        "commit": "d4e5f6a",
        "command": "corepack pnpm vitest run apps/web/src/features/profile/__tests__/ProfileForm.test.tsx",
        "exitCode": 0,
        "passedTests": ["AC-1: rejects an empty display name"],
        "output": "PASS apps/web/src/features/profile/__tests__/ProfileForm.test.tsx\n  ✓ AC-1: rejects an empty display name"
      },
      "deferral": null
    },
    {
      "requirementId": "RD-1",
      "tier": "unit",
      "testReferences": [
        {
          "file": "apps/web/src/features/profile/__tests__/ProfileForm.test.tsx",
          "name": "RD-1: preserves existing form values on save failure"
        }
      ],
      "red": {
        "commit": "b2c3d4e",
        "command": "corepack pnpm vitest run apps/web/src/features/profile/__tests__/ProfileForm.test.tsx",
        "exitCode": 1,
        "failedTests": ["RD-1: preserves existing form values on save failure"],
        "output": "FAIL apps/web/src/features/profile/__tests__/ProfileForm.test.tsx\n  × RD-1: preserves existing form values on save failure"
      },
      "green": {
        "commit": "e5f6a7b",
        "command": "corepack pnpm vitest run apps/web/src/features/profile/__tests__/ProfileForm.test.tsx",
        "exitCode": 0,
        "passedTests": ["RD-1: preserves existing form values on save failure"],
        "output": "PASS apps/web/src/features/profile/__tests__/ProfileForm.test.tsx\n  ✓ RD-1: preserves existing form values on save failure"
      },
      "deferral": null
    }
  ],
  "checks": {
    "typeCheck": {
      "command": "corepack pnpm typecheck",
      "exitCode": 0
    },
    "lint": {
      "command": "corepack pnpm lint",
      "exitCode": 0
    },
    "relatedTests": {
      "command": "corepack pnpm vitest related --run apps/web/src/features/profile/ProfileForm.tsx",
      "exitCode": 0
    }
  },
  "standardsReview": {
    "completed": true,
    "findings": []
  },
  "visualReview": {
    "completed": true,
    "findings": [],
    "screenshotPaths": ["apps/web/e2e/__screenshots__/home-light-desktop.png"],
    "componentReuseRationale": "Used PageHeader and ContentSurface from @project-scope/ui."
  },
  "escalation": null
}
```
