---
name: kick-off
description: Orchestrate significant development work from a single request — evaluates scope, interviews for missing context (including feature-flag preference), scans existing rules and skills, always persists a design doc to design-docs/ via the Write tool, then decomposes the work into TDD-driven multitask subagent phases. Use when the user says /kick-off, wants to start a new feature, requests deep module implementation, asks to create a design doc first, or wants work broken into parallel tasks with TDD Red-to-Green enforcement.
disable-model-invocation: true
---

# Kick-off Orchestration

**Before doing anything else:**
1. Call `SwitchMode` with `target_mode_id: "plan"` — this session is planning-only until the user approves the design doc.
2. Use model `claude-4.6-opus-high-thinking` (Opus 4.6) for all reasoning in this workflow. If a subagent is dispatched, pass `model: "claude-4.6-opus-high-thinking"` in the Task tool call.

Run this workflow top-to-bottom. Do not skip phases. Each phase gates the next.

---

## Phase 0: Request Intake and Classification

Read the user's request and produce a classification block:

```
Type:  new-feature | enhancement | bug-fix | refactor | spike
Scope: small (1-3 files) | medium (4-10 files) | large (10+ files)
Layers touched: server | client | shared | db | (multiple)
```

**Routing decision:**

- `small` scope AND not `new-feature` → lightweight design doc still required (see Phase 3); Phase 4 may be skipped
- All other cases → Phase 3 is mandatory before any implementation; Phase 4 is mandatory when applicable

State the classification block to the user before moving on.

---

## Phase 1: Interview (Context Gathering)

Run this phase if **any** of the following is true:
- The request is missing acceptance criteria
- The affected layers are unclear
- The request could be implemented multiple valid ways with significant trade-offs
- Scope could not be estimated confidently in Phase 0

**Always ask the feature-flag question (item 6 below)** — even when other interview questions are skipped.

Ask using the `AskQuestion` tool when it is available; ask conversationally otherwise. Cap at **2 rounds** of questions, then proceed with best available context.

**Core questions (adapt as needed):**

1. **What**: What problem does this solve? What should be true after it is done?
2. **Where**: Which layers are affected — server, client, shared types, DB migrations, or all?
3. **How**: Are there existing patterns or constraints to follow? (e.g. "match the RBAC service pattern")
4. **Dependencies**: Does this depend on or block any other in-flight work?
5. **Done criteria**: What is the minimum that must be true for this to be considered complete?
6. **Feature flag**: Should this change be gated behind a feature flag for gradual rollout?

Ask question 6 with `AskQuestion` when available:

- **Prompt**: "Do you want this change gated behind a feature flag for now?"
- **Options**: "Yes — gate behind a feature flag (recommended for user-facing changes)" | "No — ship without a flag"

If the user chooses **Yes** (or asks for a flag elsewhere in the conversation):
- Read `.cursor/skills/feature-flags/SKILL.md` immediately and treat it as mandatory for the rest of this kick-off
- Record the decision in the Scope Summary as `Feature flag: yes | no`
- When `yes`, propose a kebab-case flag key (e.g. `new-dashboard`) in the Scope Summary and confirm it with the user

After gathering answers, write a one-paragraph **Scope Summary** and confirm it with the user before continuing.

---

## Phase 2: Skills and Rules Evaluation

Read and evaluate these project assets before writing any code or design doc:

**Rules to read** (`.cursor/rules/*.mdc`):
- `scope-discipline.mdc` — always applies; note any protected files that would be touched
- `typescript-typecheck.mdc` — applies to all `.ts`/`.tsx` changes
- `react-coding-standards.mdc` — applies when client `.tsx` files are involved
- `ui-design-standards.mdc` — applies when CSS or new components are involved
- `postgresql-db.mdc` — applies when DB queries, schema, or migrations are involved
- `rbac-governance.mdc` — applies when client UI features are added or removed
- `pre-deployment-cloud.mdc` — applies if file storage or server-startup code is touched

**Skills to check** (`.cursor/skills/*/SKILL.md`):
- `fullstack-node-bff` — load for any route, hook, or shared-type work
- `postgresql-migrations` — load when a DB migration is needed
- `rbac-management` — load when RBAC adds/removes/modifies permissions
- `in-app-notifications` — load when the feature needs to send notifications to users
- `feature-flags` — **always read** when the user chose feature-flag gating in Phase 1; also load when the feature introduces or retires a flag. Follow the top-level split pattern from that skill in the design doc and every subagent prompt.

> **Skill resolution note:** If the feature involves resolving which skill repo/branch to use for an AI agent session, use `useProjectSkillConfig` (from `src/client/hooks/useProjectSkillConfig.ts`) as the canonical source for repo + branch. Do not hardcode branch names or let users pick repos manually. The admin-managed `project_skill_settings` table (managed via `/admin/project-settings`) is the source of truth.

Output a **Context Block** in this format — paste it into every subagent prompt generated in Phase 4:

```
## Context Block (inject into all subagent prompts)
Applicable rules: <comma-separated list>
Load these skills: <comma-separated list, or "none">
Feature flag: <yes — key `my-feature-key` | no>
Protected files requiring explicit permission: <list or "none">
Key existing files: <3-5 most relevant file paths>
```

---

## Phase 3: Design Doc Generation

> **Every kick-off session writes a file.** Do not skip this phase. Do not paste the design doc only in chat.

### Persist to disk (mandatory)

1. Choose a kebab-case filename from the feature name (e.g. `chat-thread-history` → `design-docs/chat-thread-history.md`).
2. Use the **Write** tool to create the file at the repository root path: `design-docs/<kebab-case-feature-name>.md`.
3. After writing, **Read** the file back to confirm it exists and matches what you intended.
4. If the Write fails, retry once; if it still fails, stop and report the error — do not proceed to Phase 4 without a persisted doc.

Use the template at [design-doc-template.md](design-doc-template.md). For `small` non-`new-feature` work, keep sections brief but still write the file.

**Required frontmatter:**
- `name` — human title
- `overview` — 1-2 sentence summary
- `todos` — one item per distinct task, grouped into phases; IDs follow `phase-N-description`; all start as `status: pending`
- `isProject: false`

**Required body sections:**
1. Current State — what exists today and why it is insufficient
2. Architecture — Mermaid `flowchart TD` diagram of the proposed system
3. Database Schema — table definitions (omit if no DB changes)
4. Server Changes — service functions, middleware, routes with HTTP verbs and paths
5. Client Changes — hooks, components, styling approach
6. Key Design Decisions — trade-offs chosen and why
7. Feature Flag (when Phase 1 answer was **yes**) — flag key, admin creation step, server entry points using `isFeatureEnabled`, client entry points using `useFeatureFlag` (top-level split only), and what the disabled path renders. Omit this section when the answer was **no**.
8. Phase Summary and Parallelization — Mermaid `flowchart LR` dependency graph plus a plain-English parallelism note per phase
9. Files Changed / Created — table of `Action | Path`

**Feature-flag implementation rules** (when gating is enabled — from `feature-flags` skill):

- Gate at the **top level** (route handler or feature entry component), never deep in nested children
- One flag per feature; name after the feature (`new-dashboard`), not a ticket id
- Disabled path must preserve prior behavior or render `null`
- Phase 1 todos should include flag setup when applicable: admin flag creation (document the key), server gating (if any server behavior), client gating at the feature entry point
- Subagent prompts for flagged work must name the flag key and cite the exact gating file(s)

**Todo phasing rules:**
- Tasks within a phase have **no dependencies on each other** (safe to run in parallel)
- Phase N+1 tasks all depend on Phase N being complete
- Aim for 3-6 tasks per phase; phases beyond 6 tasks should be split


Confirm the design doc with the user ("Here is the design doc — does this look right?") before moving to Phase 4. Do **not** wait for a separate "decompose into tasks" request.

---

## Phase 4: Task Decomposition for Multitask Mode (mandatory when applicable)

**Always run Phase 4** immediately after Phase 3 (or after Phase 2 for `small` non-`new-feature` when Phase 4 skip criteria apply) when **any** of the following is true:

- Scope is `medium` or `large`
- The design doc has **2 or more** `pending` todos
- Work spans **2 or more** layers (server, client, shared, db)
- Tasks are grouped into **2 or more** implementation phases

**Skip Phase 4** only when scope is `small`, type is not `new-feature`, and the work is a single focused change (1 todo, 1–3 files, one layer).

When Phase 4 applies, produce **subagent prompt blocks for every `pending` todo in the design doc** — all phases, not just Phase 1. Group prompts by implementation phase and include dependency gating instructions for each phase group.

**Subagent prompt structure:**

```
## Task: <todo id> — <todo content>

### Goal
<1-2 sentences describing the deliverable>

### Files to create or edit
<explicit list — no others unless unavoidable>

### Constraints
- Follow all rules in the Context Block below
- Load the skills listed in the Context Block before writing code
- Do NOT modify protected files without user approval
- If feature-flag gating applies: follow the top-level split from `feature-flags` — gate at the entry route/component with the agreed flag key; keep the legacy/disabled branch functional

### TDD Instructions (see Phase 5 below)
<paste the TDD block for this task's layer>

### Cross-task contracts
<any interfaces, types, or function signatures this task must respect from prior phases>

<paste the Context Block from Phase 2>
```

**Dependency gating:** Explicitly label which phase each group of prompts belongs to. For each phase group, tell the user:

> "Run Phase N prompts in Multitask. Only proceed to Phase N+1 after all Phase N subagents pass type-check and tests (Phase 6 gate)."

**Deliverable:** The user should leave the kick-off session with copy-paste-ready Multitask prompts for Phase 1, plus clearly labeled Phase 2+ prompts to run after each gate passes. Do not stop after producing only Phase 1 prompts when multiple phases exist.

---

## Phase 5: TDD Red-to-Green (include in every subagent prompt)

Paste the appropriate block into each subagent prompt based on which layer the task touches.

### Server task TDD block

```
TDD — Red to Green:

1. RED: Write src/server/__tests__/<module>.test.ts first.
   - Mock the Drizzle db instance: jest.mock('../db/drizzle', () => ({ db: { ... } }))
   - Follow the mock shape in src/server/__tests__/rbacService.test.ts
   - Use AAA (Arrange / Act / Assert); test public API only
   - Run: npm test -- <testfile> — confirm tests FAIL before writing implementation

2. GREEN: Write the implementation (minimum code to pass).
   - Run: npm test -- <testfile> — confirm all tests PASS

3. REFACTOR: Clean up; re-run tests to confirm still green.

4. TYPE-CHECK: npx tsc -p tsconfig.server.json --noEmit — fix all errors.
```

### Client task TDD block

```
TDD — Red to Green:

1. RED: Write src/client/components/__tests__/<Component>.test.tsx
        or src/client/hooks/__tests__/<hook>.test.ts first.
   - Use @testing-library/react + jest-environment-jsdom
   - Mock fetch and external hooks; use MSW or inline jest.fn() mocks
   - Use AAA pattern; test user-visible behavior, not implementation details
   - Run: npm test -- <testfile> — confirm tests FAIL before writing implementation

2. GREEN: Write the implementation.
   - Run: npm test -- <testfile> — confirm all tests PASS

3. REFACTOR: Clean up; re-run tests to confirm still green.

4. TYPE-CHECK: npx tsc -p tsconfig.client.json --noEmit — fix all errors.
```

### Shared-types task TDD block

```
TDD — Red to Green:

1. RED: Write tests that import and validate the new types/utilities.
   - For pure functions, use standard Jest unit tests
   - Run: npm test -- <testfile> — confirm tests FAIL

2. GREEN: Implement the types and utilities.
   - Run: npm test -- <testfile> — confirm PASS

3. TYPE-CHECK (both configs):
   npx tsc -p tsconfig.server.json --noEmit
   npx tsc -p tsconfig.client.json --noEmit
```

---

## Phase 6: Verification Gate

After all subagents in a phase complete, the **coordinator** (you, in the parent conversation) must:

1. Run type-check for all affected configs:
   ```bash
   npx tsc -p tsconfig.server.json --noEmit
   npx tsc -p tsconfig.client.json --noEmit
   ```
2. Run tests for all new test files:
   ```bash
   npm test -- --testPathPattern="<pattern covering new files>"
   ```
3. If failures: diagnose, fix inline or dispatch a targeted fix subagent, then re-run.
4. Update the design doc on disk at `design-docs/<name>.md`: change `status: pending` → `status: done` for completed tasks (use StrReplace or Write — do not only update in chat).
5. Only after all checks pass: dispatch Phase N+1 subagent prompts.

Report to the user after each phase gate:
> "Phase N complete. Type-check: ✓. Tests: ✓. Proceeding to Phase N+1."

---

## Quick-Reference Checklist

Copy and track per `/kick-off` session:

```
[ ] Phase 0 — Classification block stated
[ ] Phase 1 — Interview complete; feature-flag preference captured (yes/no + key if yes); Scope Summary confirmed
[ ] Phase 2 — Context Block produced (includes Feature flag line)
[ ] Phase 3 — Design doc **written to disk** at design-docs/<name>.md via Write tool (verified with Read)
[ ] Phase 4 — Subagent prompts produced for all applicable phases (not just Phase 1)
[ ] Phase 5 — TDD blocks embedded in each subagent prompt
[ ] Phase 6 — Gate passed after each phase before dispatching next
```
