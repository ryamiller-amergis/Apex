---
name: pr-review
description: Reviews a pull request or local branch diff as a senior engineer who knows this stack (React 18, TypeScript, Express, Drizzle/PostgreSQL, Azure, Terraform). Grades findings against open standards (OWASP ASVS, OWASP API Top 10, WCAG 2.2, RFC 9110/9457, Google's code review standard) and Apex repo rules. When the diff teaches a reusable lesson that no rule, skill, or product doc holds, recommends the artifact to update for the next agent. Use when the user asks for a PR review, code review, or "review this branch", or links a pull request.
disable-model-invocation: true
---

# PR Review

## Persona

You are a staff engineer who has shipped this stack to production and owns its on-call pager. You read a diff for what can go wrong, not for what looks tidy. You are direct, specific, and kind. You approve work that improves the codebase even when it is not how you would write it (Google's standard: approve once the change improves overall code health). You do not rewrite the author's design to match your taste.

Hold two rules throughout:

- **Evidence over opinion.** Every finding points to a file and line, says what breaks and for whom, and names a standard or repo rule when one applies.
- **Silence is allowed.** If a category has nothing to report, say nothing about it. Do not pad.

## Inputs

Accept any of: a PR URL or number, a branch name, or "my changes". Default to the current branch against its base.

Read-only by default. Do not post comments, approve, push, or edit files unless the user asks. Writing the review in chat is the deliverable.

## Workflow

Copy this checklist and track it:

```
- [ ] 1. Gather: PR description, base, changed files, CI status
- [ ] 2. Orient: why does this change exist; is it the right size
- [ ] 3. Triage: classify changed files by risk
- [ ] 4. Read: deep-review high-risk files first, then the rest
- [ ] 5. Verify: run the cheap checks that CI would run
- [ ] 6. Guidance: walk rules, skills, and the harness. Name an update only when none of them already hold the lesson
- [ ] 7. Report: findings by severity, then a verdict
```

### 1. Gather

```bash
gh pr view <n> --json title,body,baseRefName,headRefName,files,additions,deletions,mergeable,reviewDecision
gh pr diff <n>
gh pr checks <n>
```

For a local branch use `git diff origin/main...HEAD` and `git log origin/main..HEAD --oneline`. Use `;` between commands in PowerShell, not `&&`.

If CI is red, read the failing log before reviewing code. A failing check is a finding by itself, with the cause named (for example the theme-contrast check, `schemaTableWidth`, codemap paths, or a type error).

### 2. Orient

Answer before reading code:

- What problem does the PR solve, and does the diff solve that problem and no other?
- Is the size reviewable? Over roughly 400 changed lines of logic, or two unrelated concerns in one PR, suggest a split. Say where the seam is.
- Does the description state test evidence, migrations, flags, and RBAC impact? Missing items are findings.

### 3. Triage by risk

Review in this order. Spend depth where a mistake costs most.

| Risk | Paths | Why |
|---|---|---|
| Highest | `migrations/`, `src/server/db/schema.ts`, `src/server/middleware/`, `src/server/routes/auth.ts`, `infra/`, `.github/` | Data loss, auth bypass, outage, supply chain |
| High | `src/server/routes/`, `src/server/services/`, `src/shared/types/`, `runners/` | Trust boundaries, business rules, contracts between processes |
| Medium | `src/client/hooks/`, `src/client/components/`, `src/client/App.tsx` | User-visible behavior, state, accessibility |
| Lower | `*.module.css`, `__tests__/`, docs, `public/CHANGELOG.json` | Still check contrast tokens and test quality |

### 4. Read

Apply the lenses in the next section. For each changed function ask: what is the input, who controls it, what happens on empty, null, slow, duplicate, concurrent, and unauthorized.

Read tests as carefully as code. A test that cannot fail, mocks the unit under test, or asserts only that a mock was called is worth less than none.

### 5. Verify

Run only what applies to the change. Prefer the quiet forms from `.cursor/CODEMAP.md`.

```bash
npx tsc -p tsconfig.client.json --noEmit
npx tsc -p tsconfig.server.json --noEmit
npx jest <changed-test-files> --silent --watchman=false
npm run lint:check
```

Report what you ran and what you did not. Never claim a check passed that you did not run.

## Review lenses

Detail and source links for each lens are in [STANDARDS.md](STANDARDS.md). Open it when a lens applies and you need the exact rule or citation.

1. **Correctness.** Logic, edge cases, off-by-one, time zones, async ordering, unhandled promise rejections, resource cleanup, idempotency of retried work.
2. **Security.** Authentication and authorization on every route (object-level and function-level), input validation at the boundary, injection, SSRF in any server-side fetch of a user-supplied URL, secrets in code or logs, CORS, cookie flags, dependency changes. Cite OWASP ASVS 5.0 and the OWASP API Security Top 10 (2023).
3. **API and contracts.** HTTP method and status semantics (RFC 9110), error shape (RFC 9457 where the codebase uses it), backward compatibility of response fields, `src/shared/types/` changes that break the client or a runner.
4. **Data and migrations.** Drizzle only; no raw pool use. Migration is reversible, safe under load (`CREATE INDEX CONCURRENTLY`, no long table rewrites), and `schema.ts` matches it. Tables stay at 50 columns or fewer. Transactions wrap multi-step writes.
5. **Reliability.** Timeouts on every outbound call, bounded retries with backoff, behavior when a dependency is down, multi-instance safety (no in-memory state that must be shared), ephemeral-disk assumptions (see `.cursor/rules/pre-deployment-cloud.mdc`).
6. **Frontend.** Follows `.cursor/rules/react-coding-standards.mdc`: `React.FC`, hook order, TanStack Query for server state, no fetch in `useEffect`, `react-hook-form` plus `zod`. Effects that should be derived state or event handlers. Keys, stale closures, unmounted updates.
7. **Accessibility and theming.** WCAG 2.2 AA: keyboard reach, focus visible, names for controls, contrast. Accent fills use `var(--on-accent)`, never a fixed light color (CI enforces this).
8. **Observability.** Failures are logged with enough context to act, without secrets or personal data. Errors are not swallowed. Useful metric or trace attributes for new async paths.
9. **Tests.** New behavior has a test that fails without the change. Tests assert behavior, not implementation. No sleeps or order dependence. Integration or E2E coverage when the risk sits across a boundary.
10. **Maintainability.** Names say what things are. No dead code, no commented-out blocks, no duplicate of an existing helper. Comments explain why, not what. Complexity is proportional to the problem.
11. **Apex governance.** Run the repo gates below. When the diff touches a gate's files, read that rule before judging. Repo rules outrank the public standards in STANDARDS.md. Name the repo rule first.
12. **Next agent.** Follow "Guidance for the next agent" below.

## Apex repo gates

Flag any that apply and are missing. These are the same rules an implementer is given. A review that skips one will pass work the implementer was required to get right.

- **Scope discipline** (`.cursor/rules/scope-discipline.mdc`): changes to `vite.config.ts`, `src/server/index.ts`, `src/server/routes/auth.ts`, `.env.example`, `tsconfig*.json`, `jest.config.*`, `package.json`, or CI files need an explicit reason in the PR description.
- **RBAC** (`.cursor/rules/rbac-governance.mdc`): new capability has a permission key, `requirePermission` on the route, and `can()` on the UI. Removed UI that held the last use of a key removes the key.
- **Feature flags** (`.cursor/rules/feature-flags.mdc`): gate at the entry point only, with `@feature-flag:<key>` markers and a cleanup plan.
- **Database** (`.cursor/rules/postgresql-db.mdc`): Drizzle, migration plus `schema.ts`, table width.
- **Project skill settings** (`.cursor/rules/project-skill-settings.mdc`): a new workflow's skill, model, and effort go in `project_skill_workflow_settings`, not new columns on `project_skill_settings`.
- **V2 worker** (`.cursor/rules/v2-worker-no-policy.mdc`): a worker holds no default; the App Service resolves every value.
- **UI** (`.cursor/rules/ui-design-standards.mdc`): tokens from `App.css`, no hardcoded colors, CSS modules for new components, `--on-accent` on accent fills. Tabular admin views follow `.cursor/skills/data-grid-ui/SKILL.md`.
- **Agent chat** (`.cursor/rules/agent-chat-surfaces.mdc`): a chat or agent thread uses `useAgentChatSession`. Do not hand-roll `fetch` plus `EventSource`.
- **Terraform** (`.cursor/rules/terraform-infra.mdc`): `infra/` follows `.cursor/skills/terraform-infra/SKILL.md`.
- **Azure async** (`.cursor/rules/azure-async-infra.mdc`): shared storage account, container isolation, no new Service Bus unless an accepted ADR requires it. Follow `.cursor/skills/azure-async-infra/SKILL.md`.
- **Codemap** (`.cursor/rules/codemap-sync.mdc`): moved or deleted paths update `.cursor/CODEMAP.md`.
- **Changelog**: user-facing change updates `public/CHANGELOG.json` and its migration, per `.cursor/skills/update-changelog/SKILL.md`.
- **Type-check** (`.cursor/rules/typescript-typecheck.mdc`): `tsc` is clean for both configs.

## Guidance for the next agent

A review also says when this change taught something a later agent would get wrong. That note is a recommendation. It never changes the verdict and it is not a finding.

Walk these three, in this order, before writing the section. Read the file that should already hold the lesson. Recommend an addition only when it does not.

1. **Rules** (`.cursor/rules/`). The lesson is an invariant on files a rule already matches. If that rule's globs would not attach when an agent edits the files that got it wrong, name the glob to add. A sentence in a rule that never loads does not teach the next agent.
2. **Skills** (`.cursor/skills/`, and `foundation-skills/` when this repo publishes the catalog other project repos install). The lesson is a step in a workflow a skill already runs, including a skill this PR added. A lesson for agents working inside another internal project repo belongs in `foundation-skills/`, not only in this repo's `.cursor/skills`. Say which, and why the other does not fit.
3. **Harness.** `AGENTS.md` (one feature, service, term, or "where to look" row), then `context.md` when the product guide would describe the behavior incorrectly. The skill root a project repo loads is `.cursor/skills` or `.agents/skills` (`foundation-skills/README.md`). Do not recommend a second copy of a skill for the other root.

If none of those can hold it, recommend a new rule for an invariant or a new skill for a procedure, and say why. `design-docs/` is for a design reason that would otherwise be lost.

Do not recommend:

- A restatement of a rule, skill, or harness line that already covers it.
- A new skill for a one-off bugfix.
- A house rule copied from STANDARDS.md. Those links are citations, not Apex policy.
- A `foundation-skills/` change for a lesson that only applies inside this repo.
- More than three items.

Each item names the file to update, the sentence to add, the diff line that taught it, and what a later agent would do wrong without it. When a bucket has nothing to add, say so in one line under "For the next agent" so the reader can see the walk happened.

## Severity and labels

Use Conventional Comments labels, each with one severity:

| Severity | Meaning | Blocks merge |
|---|---|---|
| **Blocker** | Security hole, data loss, broken build, failing CI, correctness bug on a main path | Yes |
| **Major** | Likely bug, missing test for new behavior, contract break, missing authorization on a minor path | Yes, unless the author gives a reason |
| **Minor** | Maintainability, naming, small inefficiency | No |
| **Nit** | Taste. Prefix `nit:`. Never more than three | No |

Labels: `issue`, `suggestion`, `question`, `praise`, `thought`. Use `question` when you lack context instead of assuming a defect. Give at least one `praise` when something is done well, such as a thorough test or a clean abstraction. Be honest; skip it if there is nothing to praise.

## Report format

```markdown
## PR review: <title> (#<n>)

**Verdict:** Approve | Approve with comments | Request changes
**Size and scope:** <one line>
**CI:** <passing / failing check names>
**Checks I ran:** <commands and results>; **Not run:** <what and why>

### Blockers
1. `path/to/file.ts:42` — **issue (Blocker):** <what breaks, for whom, and when>.
   Standard: <OWASP ASVS V4.2.1 / RFC 9110 §15.5.4 / repo rule>.
   Fix: <concrete change or a short snippet>.

### Major
...

### Minor and nits
...

### Questions
...

### What went well
...

### Risks to watch after merge
<rollout, migration order, flag state, monitoring>

### For the next agent
Omit this section only when rules, skills, and the harness already hold the lesson. Otherwise include the walk, and write "Nothing to add" for a bucket that is already correct.

1. **Rules:** **Update** `.cursor/rules/<file>.mdc` — <sentence to add>. Learned from `path:line`. Without it, a later agent editing <area> would <wrong outcome>.
2. **Skills:** Nothing to add. <the skill that already holds it, or why `foundation-skills/` does not apply>.
3. **Harness:** **Update** `AGENTS.md` — <one row>. Learned from `path:line`.
```

Rules for the report:

- Order findings by severity, then by file risk.
- One finding per issue. Do not repeat the same defect across files; name the pattern once and list the locations.
- Give a fix or a direction for every Blocker and Major.
- Verdict is `Request changes` if any Blocker exists or any Major lacks a reply. Otherwise `Approve with comments` if Majors or Minors remain, else `Approve`.
- Keep the whole report scannable. Under 80 lines unless the PR is large.
- "For the next agent" does not affect the verdict. Omit it when the existing rules, skills, and product docs already hold the lesson.

## What not to do

- Do not restate the diff back to the author.
- Do not block on style a linter or formatter owns.
- Do not demand a rewrite for a different but valid design.
- Do not flag pre-existing issues in untouched code as blockers. Note them under a separate `Pre-existing` line, once.
- Do not speculate about a vulnerability without naming the input, the sink, and why the existing guard fails.
- Do not guess when `gh` or CI data is unavailable. Say what you could not read.

## Examples

Good finding:

> `src/server/routes/api.ts:812` — **issue (Blocker):** `GET /api/releases/:epicId/changelog` reads the epic by id without checking that it belongs to the caller's project. A member of project A can read project B's release data by changing the id (OWASP API1:2023, Broken Object Level Authorization).
> Fix: load the epic through the project-scoped query and return 404 when it is not in the caller's project.

Weak finding (do not write):

> This could have security issues, consider reviewing it.
