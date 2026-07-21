---
name: create-pull-request
description: >-
  Opens a GitHub pull request using the repo PR description template
  (.github/PULL_REQUEST_TEMPLATE.md). Fills Summary, Test plan, and Checklist
  from the branch diff and verification evidence. Use when the user says
  /create-pull-request, "create a PR", "open a pull request", "kick off a PR",
  or wants a templated PR description for review. Prefer build-test-push when
  they also need build, tests, commit, and push in one pipeline.
disable-model-invocation: true
---

# Create Pull Request

Open (or update) a GitHub PR whose body follows
[`.github/PULL_REQUEST_TEMPLATE.md`](../../../.github/PULL_REQUEST_TEMPLATE.md).

This skill assumes the work is already done on a feature branch. For
build → test → commit → push → PR in one run, use
[build-test-push](../build-test-push/SKILL.md) instead — but still fill the PR
body from this template (do not rely on `--fill` alone).

## Preconditions

Run in parallel:

```bash
git status
git branch --show-current
git rev-parse --abbrev-ref @{upstream} 2>$null
git log --oneline -10
git diff --stat
git diff --cached --stat
git log origin/main..HEAD --oneline
git diff origin/main...HEAD --stat
```

(On bash, use `2>/dev/null` instead of `2>$null`.)

**Hard stops:**

- On `main` / `master` with commits to publish → create/switch to a feature
  branch first (`feat/…`, `fix/…`, etc.), then continue.
- Uncommitted changes → ask whether to commit first (follow repo commit rules)
  or stash; do not open a PR that omits intended local work without asking.
- No commits ahead of the base branch and no pushable work → stop and say so.
- Never force-push, never `--no-verify`, never commit `.env` / secrets.

## Step 1 — Read the template

Read `.github/PULL_REQUEST_TEMPLATE.md` and use that structure **verbatim** for
section headings (`## Summary`, `## Test plan`, `## Checklist`).

Do not invent alternate PR layouts.

## Step 2 — Draft the body

Fill every section from evidence (diff, commits, conversation, commands run):

### Summary

- 1–3 bullets: **what changed and why** (intent), not a file dump.
- Prefer user-facing / behavioral language when applicable.

### Test plan

Turn template placeholders into real checkboxes:

- Mark `[x]` only for verification actually done in this session (or clearly
  reported by the user).
- Mark `[ ]` for recommended but not-yet-run steps; add concrete reviewer steps.
- Note which Jest suites / manual paths were exercised when known.
- Mention pre-commit ESLint if it ran on touched files.

### Checklist

For each item, mark `[x]` / `[ ]` based on the change set:

| Item | Mark `[x]` when… |
|------|------------------|
| No secrets | Diff has no `.env`, credentials, or secrets |
| DB migration | `migrations/` changed **and** local migrate was run (or note pending) |
| Changelog | User-facing/releasable change and changelog was updated (or N/A + leave unchecked with note) |
| Feature flag | Risky/partial rollout considered (flag added, or explicit “not needed”) |
| Docs / README | Setup/workflow docs changed when developer workflow changed |

If an item does not apply, leave it unchecked and add a short italic note under
Checklist (e.g. `_N/A — no schema changes_`).

Strip HTML comments from the template in the final body.

## Step 3 — Title

Write a concise PR title from the primary intent (similar to a good commit
subject). Prefer imperative mood. Do not use `--fill` as the only title source
when the draft title would be clearer.

## Step 4 — Push if needed

```bash
git status -sb
```

If the branch has no upstream or is ahead of remote:

```bash
git push -u origin HEAD
```

If push is rejected (non-fast-forward), warn the user; do not force-push.

## Step 5 — Create or reuse the PR

```bash
gh pr view --json url,state,title 2>$null
```

**Already open:** report the URL. Offer to update the body with:

```bash
gh pr edit --body "$(cat <<'EOF'
<filled template>
EOF
)"
```

Only update if the user wants a refresh or the existing body is empty/generic.

**No PR yet:**

```bash
gh pr create --base main --title "<title>" --body "$(cat <<'EOF'
## Summary

- …

## Test plan

- [x] …
- [ ] …

## Checklist

- [x] …
- [ ] …
EOF
)"
```

Use the repo default base if it is not `main` (check with
`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`).

Return the PR URL when done.

### Optional — GitHub Project

If the user asks to add a project board, use `--project` on create or
`gh pr edit` afterward. Do not add a project without confirmation.

## Guardrails

- Body must match `.github/PULL_REQUEST_TEMPLATE.md` section structure.
- Do not open a PR from `main`/`master` into itself.
- Do not fabricate passing tests — unchecked is better than a false `[x]`.
- Prefer this skill’s filled body over `gh pr create --fill`.
- Scope discipline: do not change config/infra just to get a PR open.
