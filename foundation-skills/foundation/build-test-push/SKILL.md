---
name: build-test-push
description: Build, test, lint, commit, push, and open a pull request end-to-end. Use when the user says /build-test-push, "build and push", or wants to complete a feature and open a PR in one pipeline.
disable-model-invocation: true
---

# Build Test Push — Foundation

Run the full verification pipeline for a completed feature branch, then commit, push, and open a PR.

## Phase 1 — Verify the workspace

```bash
git status
git branch --show-current
git diff --stat HEAD
```

**Hard stops:**
- Uncommitted changes → stage and commit first (follow repo commit conventions), or stash with permission.
- On `main`/`master` → create or switch to a feature branch first.
- No changes and nothing to push → stop and say so.

## Phase 2 — Build and test

Run the commands listed in the project adapter for this repo's tech stack (build, lint, test).

If any command fails:
- Fix the error in the source or test file.
- Re-run the failing command.
- After 3 failed fix attempts on the same error, stop and report the blocker.

## Phase 3 — Commit

1. `git add -A`
2. Draft a commit message following the project's commit conventions (from the adapter).
3. `git commit -m "<message>"`

## Phase 4 — Push

```bash
git push -u origin HEAD
```

If rejected (non-fast-forward), warn the user; do not force-push.

## Phase 5 — Open PR

Use the project's PR creation tool or `gh pr create`. Fill the PR body from the repo's PR template. See the `create-pull-request` skill for the PR body format.

Return the PR URL when done.
