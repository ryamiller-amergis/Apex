---
name: apex-implement-feature
description: >
  APEX-driven, full-cycle feature implementation skill. Reads the approved design doc from the ADO
  Feature (design.md / tech-spec.md / assumptions.md attachments + acceptance criteria on child PBIs/TBIs),
  drafts a Principal-Engineer implementation plan, and — after explicit human approval — delivers the
  complete feature: feature branch, code, unit tests, self code-review, commit, push, and PR, with ADO
  state transitions throughout. Use when the user runs /apex-implement-feature <featureAdoId>.
disable-model-invocation: true
---

# apex-implement-feature

Full-cycle APEX implementation: plan (stop for approval) → branch → code → test → self-review → commit → push → PR → ADO state transitions.

## Invocation

```
/apex-implement-feature <featureAdoId>
```

`<featureAdoId>` is the Azure DevOps **Feature** work item id linked to the approved APEX design doc (e.g. `42`).

---

## Phase 0 — Gather context

Run ALL of the following in parallel:

### 0a. ADO Feature + attachments

1. Use the `ado-skills` MCP `query_work_items` tool to load the Feature:

```
project: <project from session context>
wiql: SELECT [System.Id], [System.Title], [System.Description], [System.State], [System.AssignedTo] FROM WorkItems WHERE [System.Id] = <featureAdoId>
```

2. Fetch the Feature's attachment list (look for `design.md`, `tech-spec.md`, `assumptions.md`, `prototype.html`). Read each attachment using `get_skill_file` or the ADO REST attachment URL.

3. Fetch all child PBIs and TBIs:

```
wiql: SELECT [System.Id], [System.Title], [System.Description], [Microsoft.VSTS.Common.AcceptanceCriteria], [System.WorkItemType], [System.State] FROM WorkItems WHERE [System.Parent] = <featureAdoId>
```

Read the `AcceptanceCriteria` field of every child item — these are the authoritative implementation targets.

### 0b. MaxView repo context

Using the `ado-skills` MCP tools (`get_skill_file`, `list_repo_dir`, `search_repo_code`), load:

- `/CONTEXT.md` — project overview, tech stack, conventions
- `/AGENTS.md` — agent operating rules for this repo
- Relevant ADRs under `/docs/adr/` (browse with `list_repo_dir` first)
- `/.cursor/rules/*.mdc` — all coding-standards and protection rules
- The target route's existing component source (from `tech-spec.md`'s "Target route" / `decision` field):
  - For **update-page** features: search for the existing page component (`search_repo_code <targetRoute>`) and read it fully
  - For **new-page** features: read the router registration file to understand the route pattern
- MWx Design System usage patterns (`search_repo_code "from '@mwx"` or the import alias from `CONTEXT.md`)
- Test conventions: read an existing `__tests__` file for a similar component to understand naming, mocking, and assertion patterns

Summarise what you found before proceeding.

---

## Phase 1 — Principal-Engineer implementation plan

**Do not write any source code in this phase.**

Produce a thorough implementation plan structured as follows:

### 1.1 Feature summary
One paragraph: what the feature does, which ADO Feature id it implements, and its APEX design doc scope.

### 1.2 Files to create or modify

| Action | File | Purpose |
|--------|------|---------|
| Create | `src/...` | ... |
| Modify | `src/...` | ... |

Include every file — components, hooks, route registrations, API handlers (if any), test files.

### 1.3 Component / module breakdown
For each new or changed component:
- Props interface
- Internal state (`useState`, `useRef`, `useQuery`, `useMutation`, `useEffect` in hooks-order)
- Key rendering decisions (loading/empty/error states, conditional rendering)
- Which MWx Design System components to use

### 1.4 Data / API changes
- Any new API endpoint(s) needed (path, method, payload, response)
- Client query/mutation keys and stale times
- State ownership (server state via TanStack Query vs. local `useState`)

### 1.5 Existing-code protection plan
Explicitly list which existing files will **not** be touched (shell, nav, header, existing grids), and describe exactly where/how the new code is inserted into each modified file (new import + placement line).

### 1.6 Test plan
For every new file: describe the describe blocks, mocks (`jest.mock`), happy-path test, and at least one error/edge-case test.

### 1.7 Risk and existing-functionality impact
List any existing behaviour that could be affected by this change and the mitigation.

### 1.8 Sequencing
Numbered implementation steps in dependency order.

---

**STOP here. Post the plan and wait for explicit human approval before writing any code.**

When the user approves (any affirmative reply — "approved", "LGTM", "go ahead", "proceed", etc.), move to Phase 2.

---

## Phase 2 — Deliver

Execute in this exact order:

### Step 1 — Move ADO Feature to "In Progress"

Update the Feature work item state:

```
PATCH https://dev.azure.com/<org>/<project>/_apis/wit/workitems/<featureAdoId>?api-version=7.1
[{ "op": "add", "path": "/fields/System.State", "value": "In Progress" }]
```

Use the ADO PAT available in the environment (`ADO_PAT`). Report success or skip if the state is already In Progress.

### Step 2 — Create the feature branch

```bash
git fetch origin main
git checkout -b feat/apex-<featureAdoId>-<slug> origin/main
```

`<slug>` is a short kebab-case name derived from the Feature title (max 40 chars, lowercase, alphanumeric + hyphens only).

Verify the branch was created:

```bash
git branch --show-current
```

### Step 3 — Implement per plan

Follow the plan from Phase 1 exactly:

1. Work through the file list in the sequencing order from §1.8.
2. For each file: read the current state first (if modifying), then apply changes.
3. Respect all coding-standards rules in `.cursor/rules/`:
   - Use CSS Modules for new components
   - Follow hooks order (useState → useRef → useQuery/useMutation → useMemo/useCallback → useEffect)
   - Use TanStack Query for all server state — never fetch in `useEffect`
   - Use CSS variable tokens — never hardcode colours
   - **Never modify the shell, nav/sidebar, header, or any existing component not listed in the plan**
4. After implementing each file, re-read it and check for obvious issues before proceeding.

### Step 4 — Write unit tests

For each new source file, create (or update) its corresponding test file:

| Source | Test |
|--------|------|
| `src/client/components/<Foo>.tsx` | `src/client/components/__tests__/<Foo>.test.tsx` |
| `src/client/hooks/<bar>.ts` | `src/client/hooks/__tests__/<bar>.test.ts` |
| `src/server/services/<baz>.ts` | `src/server/__tests__/<baz>.test.ts` |

Requirements per test file:
- Mock all external dependencies (`jest.mock`)
- At minimum: one describe block per exported function/component, with happy-path + one error/edge case
- Tests ONLY cover the new behaviour — do not assert on existing shell, nav, or unrelated components

### Step 5 — Run the build and tests

```bash
npx tsc -p tsconfig.client.json --noEmit
npx tsc -p tsconfig.server.json --noEmit
npm test
```

If any step fails:
- Fix the errors in the source or test file (never skip type errors)
- Re-run until all pass
- If the same test fails 3 times despite fixes, stop and report to the user

### Step 6 — Self code-review

Before committing, re-read every changed file and verify:

- [ ] All existing-code protection rules respected (shell/nav/header untouched)
- [ ] CSS variables used throughout — no hardcoded colours
- [ ] Hooks in correct order in every component
- [ ] Every new component has a matching test
- [ ] No accidental `console.log` statements left in
- [ ] No `.env`, secrets, or credentials in any changed file

Report the review outcome in chat.

### Step 7 — Commit and push

```bash
git add -A
git status
```

Draft a conventional commit message:

```
feat(<scope>): <one-line summary from the Feature title>

Implements APEX-approved design doc for ADO Feature #<featureAdoId>.
- <bullet: what changed>
- <bullet: what changed>
```

Commit and push:

```bash
git commit -m "$(cat <<'EOF'
<your drafted message>
EOF
)"
git push -u origin HEAD
```

### Step 8 — Open the PR

Check for an existing PR first:

```bash
gh pr view --json url,state 2>$null
```

If none exists, create it:

```bash
gh pr create --fill --base main
```

`--fill` auto-populates title + body from the commit message. Alternatively, if using ADO PRs:

```
POST https://dev.azure.com/<org>/<project>/_apis/git/repositories/<repo>/pullrequests?api-version=7.1
{
  "title": "<Feature title>",
  "description": "Implements APEX design doc for ADO Feature #<featureAdoId>.\n\n...",
  "sourceRefName": "refs/heads/feat/apex-<featureAdoId>-<slug>",
  "targetRefName": "refs/heads/main"
}
```

Link the PR to the ADO Feature by adding a commit mention (`AB#<featureAdoId>`) in the PR description if it is not already present.

Report the PR URL.

### Step 9 — Move ADO Feature to "In Pull Request"

```
PATCH https://dev.azure.com/<org>/<project>/_apis/wit/workitems/<featureAdoId>?api-version=7.1
[{ "op": "add", "path": "/fields/System.State", "value": "In Pull Request" }]
```

Also add the PR URL as a hyperlink on the work item:

```
[{ "op": "add", "path": "/relations/-", "value": {
  "rel": "Hyperlink",
  "url": "<pr-url>",
  "attributes": { "comment": "Implementation PR" }
}}]
```

Report success.

---

## Guardrails (always enforced)

- Never `--force` push or `--force-with-lease`
- Never skip hooks (`--no-verify`)
- Never commit `.env`, `.env.local`, or any file containing secrets or credentials
- Never commit directly to `main` — always use the `feat/apex-<id>-<slug>` branch
- Never modify the shell, sidebar, nav header, or any component not listed in the Phase 1 plan
- Respect all `.cursor/rules/*.mdc` rules in the MaxView repo at all times
- If the build or tests fail 3+ times with the same error after attempted fixes, stop and report the blocker to the user instead of retrying indefinitely
