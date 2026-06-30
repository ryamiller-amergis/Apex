---
name: apex-implement-feature
description: >
  APEX-driven, full-cycle feature implementation skill. Reads the approved design doc from the
  assigned work item (and its parent Feature when the item is a PBI/Task), gathers repo context
  from the local workspace, drafts a Principal-Engineer implementation plan, and — after explicit
  human approval — delivers the complete feature: code, unit tests, and a code-reviewer subagent
  pass. APEX owns the git branch, commit, push, PR creation, and ADO state transitions.
  Use when the session is started from the APEX My Work tab.
disable-model-invocation: true
---

# apex-implement-feature

Full-cycle APEX implementation: plan (stop for approval) → code → test → code-review subagent.
APEX already created the branch `feature/apex-<workItemId>-<slug>` and owns commit/push/PR/ADO.

---

## Invocation

This skill is auto-loaded by APEX when a dev session starts. The session context includes:

- `project` — the Azure DevOps project
- `repo` — the repository name
- `branch` — the pre-created feature branch (`feature/apex-<workItemId>-<slug>`)
- `workItemId` — the assigned ADO work item id

The current working directory **is a real, full clone of the repo on the feature branch**.
Read, edit, and create files directly. Do NOT run `git push`, `git commit`, `git checkout -b`,
open PRs, or transition ADO work-item state — APEX handles all of those.

---

## Phase 0 — Gather context

Run ALL of the following in parallel.

### 0a. ADO work item + design doc

1. Use `ado-skills` MCP `query_work_items` to load the assigned work item:

```
wiql: SELECT [System.Id], [System.Title], [System.Description],
      [System.WorkItemType], [System.State], [System.Parent]
      FROM WorkItems WHERE [System.Id] = <workItemId>
```

2. If the work item is a **PBI or Task** (not a Feature), resolve its parent Feature:

```
wiql: SELECT [System.Id], [System.Title], [System.Description], [System.State]
      FROM WorkItems WHERE [System.Id] = <parentId>
```

3. Fetch the Feature's attachment list (look for `design.md`, `tech-spec.md`, `assumptions.md`,
   `prototype.html`). Read each attachment via the ADO REST attachment URL using `get_skill_file`.

4. Fetch acceptance criteria from all child PBIs/TBIs of the Feature:

```
wiql: SELECT [System.Id], [System.Title], [Microsoft.VSTS.Common.AcceptanceCriteria],
      [System.WorkItemType], [System.State]
      FROM WorkItems WHERE [System.Parent] = <featureId>
```

### 0b. Repo context (read from the LOCAL workspace — do NOT use ado-skills MCP for repo files)

The repo is already checked out in the current working directory. Use normal file read, search,
grep, and list-directory tools:

- `CONTEXT.md` — project overview, tech stack, conventions
- `AGENTS.md` — agent operating rules for this repo
- Relevant ADRs under `docs/adr/` (list the directory first)
- `.cursor/rules/*.mdc` — all coding-standards and protection rules
- The target route's existing component source (from `tech-spec.md`'s "Target route"):
  - For **update-page** features: find and read the existing page component
  - For **new-page** features: read the router registration file to understand the route pattern
- MWx Design System usage patterns (search for `from '@mwx'` or the import alias in `CONTEXT.md`)
- Test conventions: read an existing `__tests__` file for a similar component

Summarise what you found before proceeding.

---

## Phase 0.5 — Scope confirmation (interactive)

**Do not write any source code in this phase. STOP and wait for the developer's response before proceeding to Phase 1.**

From the design doc / tech-spec / prototype, enumerate every distinct change the feature introduces. For each one, classify it as either **[additive]** (introduces new UI/behaviour without touching anything that already works) or **[impacts-existing]** (could alter, remove, reorder, or make ambiguous any existing behaviour, layout, validation, default, data flow, or interaction — when in doubt, classify here).

Present the changes to the developer as **interactive multiple-choice questions — one question per change. Do NOT use a Markdown table.** The My Work chat automatically renders any run of `a.` / `b.` / `c.` option lines as clickable answer buttons with a single **Submit answers** control, so the developer picks a decision per change instead of typing free text.

Emit one block per change, in this exact shape — a short question line, a blank line, then the three lettered options each on their own line:

```
**Change 1 of N — [impacts-existing]:** <one-line description of the change>

a. Implement — build it exactly as described in the design doc
b. Defer — skip this item; do not implement it in this feature
c. Modify — implement with changes (describe them after you pick this)
```

Formatting rules so the buttons render correctly:
- One block per change; number them "Change X of N" and put the `[additive]` / `[impacts-existing]` tag in the heading line.
- Each option must start at the beginning of its line as `a.`, `b.`, `c.` (lowercase letter, period, space). Never wrap the options in a table, bullet list, or code fence in the real message.
- Keep option text short; put any extra context in the heading line above the options, not inside an option.
- Use exactly these three options — do not add a fourth; `Modify` already covers "implement with changes". The developer can use the built-in **Other / free-form** field for anything else.
- Separate consecutive change-blocks with a blank line.

**STOP. Post the per-change questions and wait for the developer to answer each one** (they submit all answers together via the Submit button). If a developer picks **Modify**, ask the follow-up for the specific change instructions before that item enters the plan.

Default rule when the developer does not explicitly respond on an item: `[additive]` → treat as `implement`; `[impacts-existing]` → **defer** (never implement an `[impacts-existing]` item without an explicit `implement` or `modify`). Only `implement`/`modify` items flow into the Phase 1 plan; state which items were deferred in the plan header.

---

## Phase 1 — Principal-Engineer implementation plan

**Do not write any source code in this phase.**

Produce a thorough implementation plan:

### 1.1 Feature summary
One paragraph: what the feature does, which ADO work item it implements, and its design doc scope.

### 1.2 Files to create or modify

| Action | File | Purpose |
|--------|------|---------|
| Create | `src/...` | ... |
| Modify | `src/...` | ... |

Include every file — components, hooks, route registrations, API handlers, test files.

### 1.3 Component / module breakdown
For each new or changed component: props interface, internal state (hooks in order), key rendering
decisions, which MWx Design System components to use.

### 1.4 Data / API changes
New API endpoints, TanStack Query keys, state ownership decisions.

### 1.5 Existing-code protection plan
List which existing files will **not** be touched, and exactly where new code is inserted.

### 1.6 Test plan
Describe blocks, mocks, happy-path test, and at least one error/edge-case test per new file.

### 1.7 Risk and existing-functionality impact
Existing behaviour that could be affected and the mitigation.

### 1.8 Sequencing
Numbered implementation steps in dependency order.

---

**STOP here. Post the plan and wait for explicit human approval before writing any code.**

When the user approves (any affirmative reply — "approved", "LGTM", "go ahead", "proceed", etc.),
move to Phase 2.

---

## Phase 2 — Deliver

### Step 1 — Implement per plan

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

### Step 2 — Write unit tests

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

### Step 3 — Run the build and tests

```bash
npx tsc -p tsconfig.client.json --noEmit
npx tsc -p tsconfig.server.json --noEmit
npm test
```

If any step fails: fix the errors (never skip type errors). If the same test fails 3 times despite
fixes, stop and report to the user.

### Step 4 — Code review subagent

Dispatch the built-in **code-reviewer** subagent via the `Task` tool:

```
subagent_type: "code-reviewer"
prompt: |
  Review the implementation of ADO work item #<workItemId> on branch <branch>.

  Design doc context: <paste the design.md summary + acceptance criteria>

  Changed files: <list from git diff --name-only HEAD~1 or the diff panel>

  Check for:
  - Acceptance criteria coverage
  - Correctness, edge cases, error handling
  - CSS token compliance (no hardcoded colours)
  - Hooks order, TanStack Query usage
  - Test coverage completeness

  Report findings by severity (blocking / advisory).
  Fix all blocking issues before handing back.
```

After the reviewer completes:
- Fix any **blocking** issues it raises, re-run tests to confirm still green.
- Advisory findings are surfaced to the user as notes.
- Do NOT commit, push, or open a PR — APEX handles that via the Push & Open PR button.

---

## Guardrails (always enforced)

- Never `git push`, `git commit`, `git checkout -b`, or create pull requests
- Never transition ADO work-item state (APEX does this)
- Never commit `.env`, `.env.local`, or any file containing secrets or credentials
- Never modify the shell, sidebar, nav header, or any component not listed in the Phase 1 plan
- Respect all `.cursor/rules/*.mdc` rules at all times
- If the build or tests fail 3+ times with the same error, stop and report the blocker
