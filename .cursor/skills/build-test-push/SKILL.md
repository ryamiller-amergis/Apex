---
name: build-test-push
description: Run build, run impacted tests, auto-fix failures, then git add/commit/push. Use when the user says "build test push", "ship it", "run the pipeline", "build and push", or wants to validate changes and commit them.
disable-model-invocation: true
---

# Build → Test → Fix → Push

Full pipeline: build, run tests scoped to changed files, auto-fix failures, then commit and push.

## Step 0 — Pull latest from main and merge into current branch

First, capture the current branch name and fetch the latest from the remote:

```bash
git branch --show-current
git fetch origin main
```

Then merge `origin/main` into the current branch:

```bash
git merge origin/main
```

**If the merge succeeds cleanly**, proceed to Step 1.

**If there are merge conflicts**, do the following:

1. Run `git status` to list all conflicted files.
2. For each conflicted file, read it and show the user the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).
3. Ask the user how they want to resolve each conflict — present both sides clearly and ask which to keep (or whether to combine them).
4. Apply the user's chosen resolution using `StrReplace` to remove the conflict markers and leave the correct content.
5. After all conflicts are resolved, stage the files and complete the merge:

```bash
git add <resolved-files>
git merge --continue
```

6. If the user wants to abort the merge instead, run:

```bash
git merge --abort
```

and stop the pipeline, reporting that the merge was aborted.

**Do not proceed to Step 1 until the merge is cleanly complete.**

## Step 1 — Identify changed files

```bash
git diff --name-only HEAD
git diff --name-only --cached
```

Collect the union of both lists. These are the **changed files**.

## Step 2 — Run the build

```bash
npm run build
```

If the build fails:
- Read the error output carefully.
- Fix TypeScript compilation errors, missing imports, or type mismatches in the reported files.
- Re-run `npm run build` until it succeeds before proceeding.
- **Do not proceed to tests if the build is broken.**

## Step 3 — Determine which tests to run

Using the changed files from Step 1, determine test scope:

| Changed path prefix | Test suite to run |
|---|---|
| `src/server/**` | `--selectProjects server` |
| `src/client/**` | `--selectProjects client` |
| Both server and client | run full `npm test` |
| Only config / non-src files | run full `npm test` (safe default) |

Also include tests for files that **import** any changed file (one level of dependency). Use:

```bash
npx jest --listTests
```

to enumerate test files, then check if any test file imports a changed file by scanning for its basename.

Run the scoped command, e.g.:

```bash
npx jest --selectProjects server --passWithNoTests
# or
npx jest --selectProjects client --passWithNoTests
# or
npm test
```

## Step 4 — Fix test failures (loop until green)

If tests fail:

1. Read each failing test's output — file path, test name, and error.
2. Determine whether the fix belongs in the **source file** or the **test file**:
   - Source fix: logic regression, missing export, wrong type — fix the source.
   - Test fix: test expectation is stale due to an intentional change — update the test.
3. Apply the fix.
4. Re-run the same scoped jest command from Step 3.
5. Repeat until all tests pass.

**Stop and report** (do not commit) if:
- The same test fails 3 times after attempted fixes.
- The fix would require changing a protected file (see scope-discipline rule).
- The failure is caused by a missing environment variable or external dependency.

## Step 5 — Commit and push

Once build and tests are green:

```bash
git add -A
```

Draft a commit message using the conventional commits format. Summarize the nature of the changes by looking at `git diff --cached --stat` and the file contents changed. Use the format:

```
<type>(<scope>): <short summary>

<optional body: why, not what>
```

Where `type` is one of: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `style`, `perf`.

Then commit and push:

```bash
git commit -m "$(cat <<'EOF'
<your drafted message>
EOF
)"
git push
```

If `git push` is rejected (non-fast-forward), run `git pull --rebase` then push again.

## Guardrails

- Never force-push (`--force`).
- Never skip hooks (`--no-verify`).
- Never commit `.env`, `.env.local`, or any secrets file.
- If on `main` or `master`, warn the user before pushing and ask for explicit confirmation.
- Respect the scope-discipline rule: do not modify config/infrastructure files to make tests pass without asking.
