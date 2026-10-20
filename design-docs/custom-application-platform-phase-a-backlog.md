# Custom Application Platform — Phase A Backlog

Goal: one app, end to end. A user describes a CRUD app in chat, approves a structured Blueprint, the platform generates it into a template workspace, verifies it with scripts, and returns a working preview behind a second approval gate. One stack, internal users only, behind a feature flag.

Exit test: describe a CRUD app -> approve Blueprint -> generated app builds and tests green -> preview link opens the running app -> Gate 2 approval recorded.

Sizes are story points (1 = half day or less, 13 = about two weeks). Confidence: H/M/L.

## EPIC A1 — App Blueprint (the structured spec)

The Blueprint is the interview brief, evolved. `interviewBriefService.ts` already versions a brief and resumes a suspended Playbook step on approval; do not fork that flow. Add a structured sidecar.

| ID | Item | Pts | Conf | Files / notes |
|----|------|-----|------|----------------|
| A1-F1 | Blueprint schema | | | |
| A1.1 | Define `AppBlueprint` type: entities (name, fields, types), roles, screens (list/detail/form), workflows, integrations, acceptance criteria. Zod schema is the contract. | 5 | H | New `src/shared/types/appBlueprint.ts`; mirror the Zod-first pattern in `playbookSteps/registry.ts` |
| A1.2 | Blueprint store: `app_blueprints` + revisions tables, versioned like `interview_briefs`/`interview_brief_revisions`. | 5 | H | `src/server/db/schema.ts`, new file in `migrations/`, update schema after migrating (project rule) |
| A1.3 | Blueprint service: create/read/save new revision, approve, "current approved version" lookup. Reuse brief error/approval shapes. | 5 | M | New `src/server/services/appBlueprintService.ts`; pattern from `interviewBriefService.ts` |
| A1.4 | Link Blueprint to interview + Playbook step run (briefId, interviewId, stepRunId), so Gate 1 approval resumes the run exactly as brief approval does today. | 3 | M | `appBlueprintService.ts`, `playbookSteps/stepRuns.ts` |
| A1-F2 | Blueprint review UI | | | |
| A1.5 | Blueprint panel in the run view: entities/screens/workflows rendered readably, diff vs previous version, Approve / Request changes. | 8 | M | New `src/client/components/AppBlueprintPanel.tsx`; copy gate UX from `PlaybookGateReviewPanel.tsx` |
| A1.6 | Tests: schema rejects unknown entity field types, approval resumes step once only, revision history immutable. | 3 | H | `src/server/__tests__/appBlueprintService.test.ts`, client test beside panel |

Epic A1 total: 29 pts.

## EPIC A2 — App-builder interview profile

Turns conversation into a complete Blueprint. Clarification asks only questions whose answers change the Blueprint.

| ID | Item | Pts | Conf | Files / notes |
|----|------|-----|------|----------------|
| A2.1 | New interview profile `app-builder` (profileKey from run input, as in `playbookTemplates/interview.json`). | 3 | M | Profile registry used by `interviewService.ts` / `interviewOrchestratorService.ts` |
| A2.2 | Skill `app-builder-interview`: fills every Blueprint field, declares what it could not settle in `unresolvedItems`, never invents entities. | 5 | M | New `.cursor/skills/app-builder-interview/SKILL.md`; style from `interview-orchestrator` + `interview-brief-draft` skills |
| A2.3 | Blocking-question rule: unresolved items above zero block Gate 1, except items the approver explicitly defers (recorded on the gate output, pattern exists in `approval-gate` answers). | 3 | M | `appBlueprintService.ts`, gate adapter `playbookSteps/approvalGateAdapter.ts` |
| A2.4 | Blueprint completeness check (deterministic): every screen names an entity, every entity has a key field, every workflow names its actor. Runs before Gate 1. | 3 | H | In `appBlueprintService.ts`; no model involved |
| A2.5 | Tests: transcript fixtures -> expected Blueprint fields; unresolved counting. | 3 | M | `src/server/__tests__/appBuilderInterview.test.ts` |

Epic A2 total: 17 pts.

## EPIC A3 — Generation and verification steps

Two new step types in the existing registry. Generation needs a writable sandbox, which `cursor-agent` deliberately refuses today (read-only MCP profiles only) — that refusal is the design constraint this epic answers.

| ID | Item | Pts | Conf | Files / notes |
|----|------|-----|------|----------------|
| A3-F1 | Sandbox workspace | | | |
| A3.1 | Per-run app workspace under the shared data root (`resolveDataRoot()` pattern), named by run id; created, staged with Blueprint JSON + template, torn down on retention policy. Never the Apex repo. | 5 | M | New `src/server/services/appWorkspaceService.ts`; `src/server/utils/dataDir.ts` |
| A3.2 | `workspace-write-sandbox` MCP capability profile: write access inside the run workspace only. Refused anywhere else, tested. | 5 | M | `playbookMcpCapabilityService.ts` (`resolvePlaybookMcpCapability`), registry descriptor update in `playbookSteps/registry.ts` |
| A3-F2 | Step types | | | |
| A3.3 | `generate-app` step type: descriptor (Zod in/out, `playbooks:run`, suspends, deadline), adapter runs the builder skill against the staged workspace, returns file manifest + build log tail. | 8 | M | `playbookSteps/registry.ts`, new `playbookSteps/generateAppAdapter.ts`, dispatch in `playbookSteps/index.ts` |
| A3.4 | Builder skill `app-builder-generate`: reads Blueprint JSON, scaffolds CRUD per entity into the template, writes a manifest of what it created and what it skipped. | 8 | L | New `.cursor/skills/app-builder-generate/SKILL.md`; template from EPIC A4 |
| A3.5 | `verify-app` step type: no model. Runs template scripts (build, unit tests, API smoke) in the workspace, captures exit codes + logs, returns pass/fail per check. Failed verify routes back to generate once, then to a human. | 8 | M | New `playbookSteps/verifyAppAdapter.ts`; branch on output via existing `branch` step |
| A3.6 | Tests: step refuses to write outside workspace; verify fails the step on red build; retry-once loop terminates. | 5 | M | `src/server/__tests__/generateAppAdapter.test.ts`, `verifyAppAdapter.test.ts` |

Epic A3 total: 39 pts. This is the riskiest epic; A3.4 carries the only L.

## EPIC A4 — Template stack (CRUD v1)

One boring stack so generation has a target: Vite + React front end, Express API, SQLite file database, Vitest + Supertest. One command builds, one starts, one tests — verify-app depends on those commands existing.

| ID | Item | Pts | Conf | Files / notes |
|----|------|-----|------|----------------|
| A4.1 | Template skeleton: auth stub (single internal user), entity CRUD API pattern, list/detail/form screens, seed data. | 13 | M | New `app-templates/crud-v1/` at repo root |
| A4.2 | Template scripts contract: `npm run build`, `npm test`, `npm run start` with port from env. Documented in template README. | 3 | H | `app-templates/crud-v1/package.json` |
| A4.3 | Golden test: hand-written Blueprint for a two-entity app (e.g. Clients + Appointments) that the builder skill must reproduce into a passing build. This fixture gates A3.4. | 5 | M | `app-templates/crud-v1/fixtures/` |

Epic A4 total: 21 pts. Start A4.1 in parallel with A1; generation work is blocked without it.

## EPIC A5 — Playbook template and preview

Wire the pieces into one run a user can launch, and give the result a screen.

| ID | Item | Pts | Conf | Files / notes |
|----|------|-----|------|----------------|
| A5.1 | `app-builder` Playbook template: interview -> Gate 1 (Blueprint) -> generate -> verify -> branch (fail: human) -> preview -> Gate 2 -> notify. Published via the existing template service. | 5 | H | New `src/server/playbookTemplates/app-builder.json`; `playbookTemplateService.ts` seeds it |
| A5.2 | Preview runner: starts the verified workspace on an ephemeral port, authenticated reverse proxy under `/api/app-preview/:runId/*`, stops on gate decision or 48h deadline. Internal network only. | 13 | L | New `src/server/services/appPreviewService.ts`, route in `src/server/routes/`; heaviest single item in Phase A — spike first (see Risks) |
| A5.3 | Run view additions: preview link + iframe panel, verify report (per-check pass/fail + log tail), Gate 2 in the existing gate panel. | 8 | M | `PlaybookLiveRunPage.tsx`, `PlaybookGateReviewPanel.tsx`, new `AppVerifyReportPanel.tsx` |
| A5.4 | Launch entry: "Build an app" on the Playbooks dashboard, starts the template with the user's first message as run input. | 3 | H | `PlaybookDashboardPage.tsx` |
| A5.5 | End-to-end test: scripted run from launch to Gate 2 against the golden Blueprint, in CI with the agent step stubbed. | 5 | M | `src/server/__tests__/appBuilderPlaybook.test.ts` |

Epic A5 total: 34 pts.

## EPIC A6 — Guardrails and operations

Phase A runs for internal users behind a flag; these items keep that safe and measurable.

| ID | Item | Pts | Conf | Files / notes |
|----|------|-----|------|----------------|
| A6.1 | Feature flag `app-builder` (default off, enabled branch recorded at creation, per feature-flag skill). | 2 | H | `featureFlagService.ts` conventions; `@feature-flag:app-builder` markers |
| A6.2 | Spend: confirm run cost lands in aiUsage via the Playbook thread anchor; per-run cap from `playbookSpendPolicyService` applied to generate steps. | 3 | M | `aiUsageService.ts`, `playbookSpendPolicyService.ts` |
| A6.3 | RBAC: Phase A reuses `playbooks:run` + `playbooks:author`; no new keys yet (new keys are Phase B, via the rbac-management skill). Gate 2 restricted to run initiator in Phase A. | 2 | H | `playbookGateService.ts` approver resolution |
| A6.4 | Runbook: how to inspect a failed generate/verify, where workspaces and logs live, how to kill a preview. | 2 | H | New `design-docs/app-builder-phase-a-runbook.md` |
| A6.5 | Outcome feedback wired: Gate 2 decision captured by the existing `capture-outcome-feedback` step so Phase E has data from day one. | 3 | H | Template (A5.1) + `playbookOutcomeFeedbackService.ts` |

Epic A6 total: 12 pts.

## Totals and sequence

| Epic | Points | Depends on |
|------|--------|-----------|
| A1 Blueprint | 29 | — |
| A2 Interview profile | 17 | A1.1 schema |
| A3 Generate + verify | 39 | A1, A4 scripts |
| A4 Template stack | 21 | — (start day one, parallel) |
| A5 Playbook + preview | 34 | A1–A4 |
| A6 Guardrails | 12 | A5 (flag first, before any of it merges) |

Total: 152 points — roughly 5–7 weeks for two engineers, matching the earlier 4–6 week estimate once the preview spike is included.

Build order: A6.1 flag -> A1 + A4.1 in parallel -> A2 -> A3 -> A5 -> rest of A6.

## Decisions locked for Phase A

- Extend the Playbook step registry; no second orchestrator. New step types are descriptors in `playbookSteps/registry.ts` plus an adapter each.
- Blueprint extends the interview brief flow; approval resumes the suspended step the way brief approval already does.
- Verify is scripts and exit codes. Models generate and explain; they never pass their own gate.
- One stack, SQLite, internal preview only. Production runtime, multi-app hosting, and the capability registry are Phases B–C, deliberately not here.

## Risks and spikes

1. A5.2 preview runner (L): how Apex hosts an untrusted generated process safely. Spike in week 1: process isolation, port allocation, proxy auth. If the spike fails, Phase A preview degrades to "download and run locally" and the exit test changes.
2. A3.4 generation quality (L): the golden fixture (A4.3) exists to measure this before the pipeline depends on it. If the skill cannot hit the fixture reliably, narrow the Blueprint (fewer field types) rather than weakening verify.
3. Blueprint schema churn: version every revision (A1.2) so a schema change never invalidates an in-flight run — runs pin their Blueprint version the way runs pin Playbook versions today.
