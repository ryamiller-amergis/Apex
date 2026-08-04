---
name: create-pull-request
description: Opens a pull request using the repo PR description template. Fills Summary, Test plan, and Checklist from the branch diff and verification evidence. Use when the user says /create-pull-request, "create a PR", or "open a pull request".
disable-model-invocation: true
---

# Create Pull Request — Foundation

Open (or update) a PR whose body follows the repo's PR description template.

## Preconditions

Run in parallel:

```bash
git status
git branch --show-current
git log --oneline -10
git diff --stat
git log origin/main..HEAD --oneline
git diff origin/main...HEAD --stat
```

**Hard stops:**
- On `main`/`master` with commits → create/switch to a feature branch first.
- Uncommitted changes → ask to commit or stash first.
- No commits ahead of the base → stop.
- Never force-push, never `--no-verify`, never commit `.env`/secrets.

## Step 1 — Read the template

Read the project's PR template (`.github/PULL_REQUEST_TEMPLATE.md` or equivalent from the project adapter) and use its section structure verbatim.

## Step 2 — Draft the body

Fill every section from evidence (diff, commits, conversation, commands run):

- **Summary**: 1–3 bullets — what changed and why (intent), not a file dump.
- **Test plan**: checkboxes — mark `[x]` only for verification actually done; `[ ]` for recommended but unrun steps.
- **Checklist**: mark `[x]`/`[ ]` based on the change set (no secrets, DB migration, changelog, feature flag, docs).

## Step 3 — Title

Write a concise PR title from the primary intent. Prefer imperative mood.

## Step 4 — Push if needed

```bash
git push -u origin HEAD
```

## Step 5 — Create or reuse the PR

Check if a PR already exists: `gh pr view --json url,state,title`. If open, offer to update the body. If not, create:

```bash
gh pr create --base main --title "<title>" --body "$(cat <<'EOF'
<filled template>
EOF
)"
```

Return the PR URL when done.

## Guardrails

- Body must match the repo template section structure.
- Do not fabricate passing tests.
- Prefer this filled body over `gh pr create --fill`.
