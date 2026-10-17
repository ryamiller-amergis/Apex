# Technical Specification — ATS Discovery Interview Skill

> **PRD slug:** `ats-discovery-interview-skill` | **Owning layer:** `.cursor/skills/ats-discovery-interview/` (Skill content) plus a `project_skill_settings` data change | **Surface:** Skill content only (no frontend, backend, shared type, or database code)
> **Verification builds:** `npx tsc -p tsconfig.server.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit` (both must stay clean; no TypeScript change is expected)
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (8 unresolved)
> **Design doc:** [design-doc-design.md](design-doc-design.md)

---

## System Boundary and Owning Layer

**Owning layer:** `.cursor/skills/ats-discovery-interview/SKILL.md` (new file), loaded from the skill repository named in the pilot project's skill settings. The only other change is data on one `project_skill_settings` row, made in the existing Project Settings screen. Three small documents sit beside the Skill: `design-docs/ats-discovery-pilot-runbook.md`, `design-docs/ats-discovery-pilot-checklist.md`, and `design-docs/ats-discovery-pilot-results.md`.

**Rationale:** Apex already runs interviews as Skills: the project settings pick the Skill, `chatAgentService.ts` loads it and streams the reply, and the thread tables store the conversation. Every requirement in the PRD (one question per reply, ledger, redaction, citations, completion) is behavior that a Skill can state to the model. Nothing needs a new service, route, type, or table. Putting the work in a Skill also keeps it out of the existing `grill-with-docs` Skill, as the PRD requires. The Skill path must not contain the text `grill-with-docs`: `usesGuidedInterview` and `usesGuidedInterviewPhases` use that text to switch on server-controlled turn markers and the phase bar, and those would force the six-topic Discovery plan on a lifecycle interview. The cost is that the server enforces none of the Skill's rules, so the tests in this spec check behavior directly.

**Ownership answers:**
- New or existing Express service in `src/server/services/`? **No.** Reused unchanged: `chatAgentService.ts` (load Skill, stream, recover, web-research wiring), `interviewService.ts` (create, status), `projectSettingsService.ts` (settings row), `prdService.ts` (PRD generation). `guidedInterviewState.ts` stays untouched and must keep returning false for the ATS path.
- New or existing route in `src/server/routes/`? **No.** Reused unchanged: `chat.ts`, `interviews.ts`, `admin.ts`, and the `GET /api/skill-config` handler in `api.ts`.
- New React component in `src/client/components/`? **No.** `InterviewChatView.tsx` already lists `interviewSkillOptions`, and `AdminProjectSettings.tsx` already edits them and the web research settings.
- New shared type in `src/shared/types/`? **No.** `InterviewSkillOption`, `QuickMcpPill`, and `ProjectSkillConfig` in `projectSettings.ts` already carry every field this Feature sets.
- Database migration needed? **No.** The three settings columns exist (`interview_skill_options`, `interview_web_research_enabled`, `interview_web_mcp`). This Feature changes row values, not schema.

---

## Security Enforcement

- **Authorization mechanism:** No new permission key and no `can()` change, so the `rbac-management` skill is not needed (`rbac-governance.mdc`, "Evaluation Checklist", item 2: reuse existing keys). Existing guards apply unchanged:
  - Start: `POST /api/interviews` uses `requirePermission('interviews:manage')` and `requireGroupMembership('BA', 'Manager', 'Product-Owner')`.
  - Read: `requirePermission('interviews:view')`.
  - Send and cancel: `router.use(requirePermission('chat:view'))` plus `requireThreadWrite` (thread owner) in `chat.ts`. Other users get a 404.
  - Mark complete: `updateInterviewStatus` throws 403 unless the user is the interview author.
  - Settings: `router.use(requirePermission('admin:roles'))` in `admin.ts` covers `POST /project-settings` and `PUT /project-settings/:id`.
- **Layer that enforces scope:** Route middleware and the service layer, both existing. The Skill never grants or denies access. The interview row stores one `project`, and the thread belongs to the user who created it.
- **Sensitive data handling:** Handled by Skill instructions only, so it lowers risk and cannot guarantee that no identifier reaches a search.
  - Identifier classes are redacted before every query, and the redacted query is printed in chat before the search starts (TBI-003).
  - Search results are data. The Skill never follows instructions found inside a result page.
  - The three outputs use generic descriptors and record sources and dates, not identifiers.
  - Web MCP secrets stay in `${VAR_NAME}` references resolved from the server environment, as `QuickMcpPill` already requires. They never appear in the Skill or in settings values.
  - The stored conversation keeps what the leader typed (existing interview storage; out of scope).

---

## Architecture and Approach

### Layers touched

| Layer | Changed | Notes |
|-------|---------|-------|
| Server services (`src/server/services/`) | No | `chatAgentService.ts`, `interviewService.ts`, `projectSettingsService.ts`, `prdService.ts` run as they are |
| Server routes (`src/server/routes/`) | No | `chat.ts`, `interviews.ts`, `admin.ts`, `api.ts` run as they are |
| Server middleware (`src/server/middleware/`) | No | Existing `requirePermission` and `requireGroupMembership` |
| Client components (`src/client/components/`) | No | `InterviewChatView.tsx` and `AdminProjectSettings.tsx` run as they are |
| Client hooks (`src/client/hooks/`) | No | No change |
| Shared types (`src/shared/types/`) | No | Existing fields suffice |
| Database (migrations/) | No | Data change on one row, no DDL |
| Drizzle schema (`src/server/db/schema.ts`) | No | Columns already typed (`interviewSkillOptions`, `interviewWebResearchEnabled`, `interviewWebMcp`) |
| Skill content (`.cursor/skills/`) | Yes | New `ats-discovery-interview/SKILL.md`, plus three documents under `design-docs/` and one dev script under `scripts/dev/` |

### Runtime contracts the Skill depends on (verified at SHA `f8b864f`)

| Contract | Source | What it means for the Skill |
|----------|--------|-----------------------------|
| Guided-interview switch is a path substring test | `usesGuidedInterview` in `guidedInterviewState.ts`; `usesGuidedInterviewPhases` in `interviewPhaseProgress.ts` | Path `.cursor/skills/ats-discovery-interview/SKILL.md` gets no markers, no phase bar, no server-closed repository tools. The Skill must close repository tools itself |
| Picker rule for interview options | `InterviewChatView.tsx` lines 387–395, 736–761 | Zero options use the fallback, one option auto-selects and hides the dropdown, two or more show a dropdown and preselect the first. The pilot lists the existing option first |
| Web research needs three things | `enrichKickoffForInterviewWebResearch` in `chatAgentService.ts` | `interviewWebResearchEnabled` true, `interviewWebMcp` set, and the thread's `skillPath` listed in `interviewSkillOptions` or `interviewSkillPath`. Removing the option later drops research for threads already open |
| Scope policy text | `buildScopePolicyLines` in `chatAgentService.ts` | The agent refuses general or public-data questions unless the web-research carve-out is on. No per-option bypass exists |
| Lettered lines become buttons | `parseAgentMessage.ts` | Ledger lines never start with `a.` to `e.` or `A)`. The question block is last |
| Recovery context | `buildAgentRecoveryContext`, limit 100,000 characters, 30% head and 70% tail | Every reply carries the whole ledger |
| Run health limits | `buildRunStatusResponse` in `chat.ts` (`hard_timeout`, `progress_timeout`) | Research per reply stays small |
| Write and complete rights | `requireThreadWrite`, `updateInterviewStatus` | One owner drives and completes the interview |
| Settings save | `AdminProjectSettings.tsx` line 2033 | `interviewWebMcp` persists only while research is on |

### Per-work-item design decisions

**TBI-001 — Author the ATS discovery Skill definition and interview flow**
- Pattern followed: `adr-interview` for a single-purpose, non-guided Skill that closes by writing `.ai-pilot/kickoff-transcript.md`, and `grill-design` as the existing non-guided interview Skill (the client test asserts it is not guided). Frontmatter and the "Linked context pre-read" block follow the repository Skill format.
- Key decisions:
  - **One file, one path:** `.cursor/skills/ats-discovery-interview/SKILL.md`. Rejected: a path containing `grill-with-docs` to get server-enforced markers, because the server would then run its six-topic Discovery plan and block repository tools, and the lifecycle plan cannot fit without a runtime change.
  - **Rejected: `foundation-skills/` catalog.** That catalog is for project-agnostic Skills linted for project terms (`docs/APEX_FOUNDATION_SKILLS.md`, section 5a). A pilot Skill for one organisation does not belong there.
  - **Section order in the Skill:** Linked context pre-read; Operating rules; Opening; Lifecycle areas; Phase 1 rule; Decision ledger rules; Research and redaction rules; Resume and recovery; Completion rubric and output contract; What this Skill does not do.
  - **Operating rules:** one question at the end of every reply; no repository tools (no grep, glob, read, `search_repo_code`, `get_skill_file`, `list_repo_dir`); no feature-parity checklist; treat the first message `Begin.` as a request to open with the vision question.
  - **Opening:** the first question asks for leadership's vision in the leader's own words. No search runs before the vision is recorded as a decision.
  - **Phase 1 rule:** an item belongs in Phase 1 only if removing it stops one real piece of work from going through the whole workflow, from first input to final output. Every other item goes to the deferred roadmap with a revisit trigger.
  - **Lifecycle areas** (working list, pending the ADR; see ⚠ in the assumptions file):

| ID | Area |
|----|------|
| L01 | Demand and requisition intake |
| L02 | Candidate sourcing and attraction |
| L03 | Application intake and candidate profile |
| L04 | Screening and qualification |
| L05 | Matching and submission to the client |
| L06 | Interview and selection coordination |
| L07 | Offer and placement |
| L08 | Onboarding and compliance |
| L09 | Assignment management and hand-off to timekeeping, payroll, and billing |
| L10 | Client and vendor relationship management |
| L11 | Reporting and analytics |
| L12 | Integration, data migration, security, and administration |

  - **Question format:** one short question, then up to four lettered answers, then `Skip — decide later` as the last answer. A lifecycle area the leader skips becomes an `unresolved` row and is not asked again.

**TBI-002 — Define decision ledger rules and conflict handling**
- Pattern followed: the `Skip — decide later` and "quote conflicting decisions without judgment" rules in `grill-with-docs`, applied here by text only. The ledger lives in reply text and chat storage; no new store.
- Key decisions:
  - **State definitions, one example each (Skill text):** *confirmed* — the leader said "yes, web form only for requisitions"; *assumed* — the Skill proposed a rule and the leader has not replied, or the only basis is an uncorroborated claim; *unresolved* — the leader skipped, or research could not settle it; *superseded* — replaced by a later decision the leader named.
  - **Row grammar:** `D07 · confirmed · Phase 1 workflow · Requisitions enter by web form only · L01 · basis leader`. Research rows add `· cite: {publisher}, {page}, {YYYY-MM}`, plus `+ {publisher2}, {page}, {YYYY-MM}` when corroborated, or `· uncorroborated`. Superseded rows shrink to `D05 · superseded by D12 · Phase 1 workflow`. A conflict is a note, `[conflict with D12]`, never a fifth state.
  - **Full ledger in every reply**, under the header `Decision ledger — changed this reply: D07, D12 — 14 rows`. Cap 40 rows, 160 characters per row. A reply that changes no decision still shows the ledger.
  - **Conflict procedure:** when a new answer conflicts with a confirmed or assumed row on the same topic, the reply quotes both in a short line each, with no judgment; raises no new topic and runs no search; and asks which is authoritative with three answers: keep the earlier decision, use the new answer, or restate. There is no skip. The next reply marks the other row superseded.
  - **Correction:** a leader message such as "D04 should be confirmed" restores that row in the next reply, and the Skill names the row it changed.
  - **Resume and recovery:** on a message that follows a gap, or when the conversation starts with `# Recovered conversation history`, the Skill rebuilds the ledger from the latest full ledger in the conversation, shows it, and asks the next open question. If the last agent message announced a search with no result, every decision that depended on it becomes `assumed` or `unresolved` with the note `research interrupted`.
  - **Basis rule:** a decision whose stated basis is a claim cannot be `confirmed` while that claim is uncorroborated. A decision the leader makes on their own judgment can be `confirmed` with `basis leader`.

**TBI-003 — Define research, source, and redaction rules**
- Pattern followed: the web-research carve-out text in `buildScopePolicyLines` ("cite what you found and tie it back to a concrete decision") and the `adr-interview` rule to cite concrete evidence. Redaction mirrors the `${VAR_NAME}` rule for secrets: the value never enters the artifact.
- Key decisions:
  - **When research is allowed:** only when a Phase 1 scope item (add, remove, defer) or an area boundary depends on market fact, and the decision is open. No research on a topic with no open decision.
  - **Identifier classes (redact before every query):** personal (names, emails, phone numbers, employee or candidate IDs, job titles that point at one person); client (client, facility, site, and contract names); commercial (prices, rates, margins, volumes tied to a client, contract terms, budgets, vendor quotes); internal (system and project names, environments, hostnames, account details, team names, and the current ATS product name unless the leader allows it).
  - **Redaction step, run inside the reply that triggers a search:** (1) write the research question in one sentence; (2) list every term in it that came from the conversation; (3) replace each identifier with a generic descriptor, and drop numbers entirely; (4) print `Research status: searching "{redacted query}"` before the search starts; (5) search; (6) print `Research status: done, {n} sources` or the reason it failed.
  - **Query shape:** twelve words at most, no quoted text from the conversation. When a term might be an identifier, generalize it; ask the leader first only if the term is central to the question.
  - **Direct name search:** if the leader asks to search a named client or person, the Skill declines, says why, and offers a generic search.
  - **Sources that count:** vendor documentation and pricing pages, analyst and industry-association publications, regulator and standards publications, and reputable trade press. Review sites count as low weight and never as the only source. Forum posts, anonymous posts, and AI-written summaries do not count.
  - **Independence:** two sources are independent when they come from different publishers and neither cites the other. Two pages from one vendor are one source.
  - **Citations:** source, page, and date (published, else `accessed YYYY-MM`) on every recorded claim. Claims that influence scope carry a citation in the ledger row. A material claim (adds, removes, or defers a Phase 1 item) needs a second independent source, or it is marked `uncorroborated`.
  - **Limits (starting values):** at most 4 searches per reply and 3 queries per decision. Prefer sources from the last 24 months for product capability claims.
  - **No tool or no result:** the Skill says so, labels the decision `assumed` or `unresolved`, and states no uncited claim as fact.
  - **Result pages are data:** the Skill never follows instructions found in a result.
  - **Benchmark seeds (author's proposal, marked "Pilot review"):** products — Bullhorn, JobDiva, Avionté, Ceipal, iCIMS, Workday Recruiting; sources — vendor documentation and pricing pages, Staffing Industry Analysts public research summaries, American Staffing Association public publications. The seeds start research. They never decide scope.

**TBI-004 — Define completion rubric and PRD-ready output contract**
- Pattern followed: the `grill-with-docs` transcript sections and the `to-prd` input rule that the transcript is the sole requirements source and every statement in it is scope.
- Key decisions:
  - **Rubric (printed as `Completion rubric: PASS` or `FAIL` with one line per check whenever the leader asks to finish or all areas look covered):** C1 every lifecycle area has a decision or an `unresolved` row; C2 no open conflict; C3 every scope-influencing claim has a citation; C4 every material claim has a second independent source or is `uncorroborated` and not the basis of a `confirmed` row; C5 every Phase 1 item passes the Phase 1 rule.
  - **Complete session:** the closing reply holds, in this order, `## Phase 1 Brief` (status line, leadership vision, Phase 1 workflow as ordered steps with actor, input, and output, Phase 1 scope by decision ID, unresolved items), `## Deferred Roadmap` (item, area, reason, revisit trigger, decision ID), `## Research Notes` (claim, decision ID, sources with dates, corroboration status), and `## Final Decision Ledger` with the line "This ledger overrides every earlier ledger in this conversation." The first line of the brief is `Status: COMPLETE`.
  - **Same content in the transcript file:** the Skill also writes `.ai-pilot/kickoff-transcript.md` with the same four sections, as `adr-interview` does.
  - **Draft session:** if the rubric fails, the Skill names each failed check, asks one question to close the most important gap, and produces no completed brief. If the leader stops anyway, the Skill writes the same four sections with `Status: DRAFT`, lists the gaps, and says "Do not mark this interview complete."
  - **Separation:** deferred items appear only in the deferred roadmap, never in Phase 1 scope. Unresolved items appear in the brief and the roadmap, never as decided.
  - **Generic wording:** outputs use the generic descriptors used in queries.

**TBI-005 — Configure the pilot project and fallback**
- Pattern followed: the existing interview-option and web-research settings in `AdminProjectSettings.tsx`, as used by `interview_flow_configuration` (`design-docs/interview_flow_configuration_e7cfe458.plan.md`).
- Key decisions (runbook values for the pilot project's default settings row):

| Setting | Value |
|---------|-------|
| `interviewSkillOptions[0]` | The existing interview option, unchanged, so it stays the default |
| `interviewSkillOptions[1]` | `{ key: 'ats-discovery', friendlyName: 'ATS Discovery Interview', path: '<same path form as the existing option>/ats-discovery-interview/SKILL.md', wantsDesignPrototype: false, wantsTestCases: false }`. Add `model` only if the pilot needs a stronger model than `interviewModel` |
| `interviewWebResearchEnabled` | `true` |
| `interviewWebMcp` | The web-search MCP pill named in the assumptions file |
| Repository checkout | After the Skill merges to the configured branch, run Clone or Refresh on the row. Require `repositoryCheckoutStatus` `ready` and `repositoryCheckoutSha` equal to the merge commit |

  - **Order of steps:** merge the Skill; refresh the checkout; edit settings; start an interview with each option; confirm the dropdown shows both options and the other projects show neither.
  - **Removal (kill switch):** delete the ATS entry from `interviewSkillOptions` and save. Leave the Skill file in place, because open threads still reference it. Interviews in progress stay readable. They lose web research, and model and effort fall back to the interview defaults, because the thread's path is no longer listed.
  - **Warning in the runbook:** turning research off and saving erases `interviewWebMcp`. Research applies to every interview option on the row, including the fallback.
  - **Rejected: a dedicated settings row** for the pilot. It would isolate research from the fallback, but it adds a checkout, approver pools, and a row choice at interview start.

**TBI-006 — Define pilot scenarios and acceptance checklist**
- Pattern followed: `scripts/dev/v2-flow-harness.mjs` for scripted sessions (create thread, create interview, post a turn, follow the stream), and the pass or fail style of the existing `@interview-flow` Playwright tests.
- Key decisions:
  - **Scenarios**, all on synthetic data with no production client data: S-A normal run through all areas to a complete brief; S-B conflict; S-C resume after a break (restart the dev server between turns); S-D seeded identifiers (client `Zephyr Health Staffing`, price `$41.37 per hour`, person `Dana Whitfield`, system `ProjectHeron`).
  - **Checklist**, pass or fail with no numeric score: coverage or unresolved label on every area; decisions retained across turns and resume; scope-influencing claims cited; material claims corroborated; resume works; view-only user is refused; interview marked complete only after a `Completion rubric: PASS` reply; Product-Owner accepts the PRD-ready output. Pass conditions 1–6 map to the first five checks plus the Product-Owner check.
  - **Runtime gap:** a finding that needs a change to the chat service, interview flow, UI, API, database, or settings schema. Examples: server-enforced single question, a Mark Complete gate, redaction of the stored conversation, a per-Skill scope bypass, or tool-call logging. Each goes to a separate PRD.
  - **Results:** one markdown file, `design-docs/ats-discovery-pilot-results.md`, with sources and dates and no identifiers.

**PBI-001 — Shape a Phase 1 MVP through a guided leadership interview**
- Pattern followed: existing interview start flow (`POST /api/chat/threads` then `POST /api/interviews`), unchanged.
- Key decisions: delivered by TBI-001. Error handling is the existing run error and retry (`POST /api/chat/threads/:id/runs/:runId/retry`). Alternative rejected: server-side question counting, which needs the guided-interview runtime.

**PBI-002 — Keep a visible ledger of decisions**
- Pattern followed: reply text plus chat message storage.
- Key decisions: delivered by TBI-002. A ledger table or screen is out of scope. The full ledger in each reply is what makes recovery safe.

**PBI-003 — Test Phase 1 decisions with cited research**
- Pattern followed: existing web-research wiring (`interviewWebMcp` through `enrichKickoffForInterviewWebResearch`).
- Key decisions: delivered by TBI-003. The Skill, not code, decides when research is relevant.

**PBI-004 — Keep sensitive ATS details out of web research**
- Pattern followed: none in code; instruction-level redaction as in the PRD assumption.
- Key decisions: delivered by TBI-003. Printing the redacted query before the search lets the leader and the tester see it. Rejected: an automated scanner outside the Skill (PRD out of scope).

**PBI-005 — Pause and resume an ATS interview without losing decisions**
- Pattern followed: existing thread hydration and recovery (`getThread`, `buildAgentRecoveryContext`).
- Key decisions: delivered by TBI-002 resume rules. Resume is owner-only because `requireThreadWrite` is owner-only.

**PBI-006 — Receive a PRD-ready Phase 1 brief, deferred roadmap, and research notes**
- Pattern followed: `POST /api/interviews/:interviewId/prds` with a PRD chat thread seeded from the interview.
- Key decisions: delivered by TBI-004. Fixed headings let PRD generation and the checklist find each output.

**PBI-007 — Enable the ATS discovery Skill for the pilot project**
- Pattern followed: `PUT /api/admin/project-settings/:id` from `AdminProjectSettings.tsx`.
- Key decisions: delivered by TBI-005. No new settings screen.

**PBI-008 — Accept or reject the ATS discovery pilot**
- Pattern followed: manual checklist; no Apex action.
- Key decisions: delivered by TBI-006. All pass conditions must hold. A missing Product-Owner acceptance fails the pilot.

---

## Data and Contracts

### API endpoints

No endpoint is new or changed. These existing endpoints carry the Feature.

| Method | Route | Request shape | Response shape | Auth |
|--------|-------|--------------|----------------|------|
| PUT | `/api/admin/project-settings/:id` | `UpsertProjectSkillConfigRequest` with `interviewSkillOptions`, `interviewWebResearchEnabled`, `interviewWebMcp` | `ProjectSkillConfigResponse` and `approvalModes` | `requirePermission('admin:roles')` |
| GET | `/api/skill-config` | Query `project` or `settingsId` | Explicit field list including `interviewSkillOptions`, `interviewWebResearchEnabled`, `interviewWebMcp` | Session-authenticated |
| POST | `/api/chat/threads` | `kickoff` with `project`, `repo`, `skillPath`, `skillSettingsId` | `{ threadId }` | `chat:view` |
| POST | `/api/interviews` | `project`, `repo`, `title`, `chatThreadId`, `skillSettingsId`, `prdOwnerId`, `prototypeStageEnabled`, `testCasesEnabled` | `{ interviewId, threadId }` | `interviews:manage` and group BA, Manager, or Product-Owner |
| POST | `/api/chat/threads/:id/messages` | `{ turnId, text }` | `202` `{ turnId, runId, status, interactiveClass }` | `chat:view` and `requireThreadWrite` |
| POST | `/api/chat/threads/:id/runs/:runId/retry` | none | `202` accepted turn | `requireThreadWrite` |
| PATCH | `/api/interviews/:id` | `{ status: 'complete' }` | `{ ok: true }` | `interviews:manage`; author only |
| POST | `/api/interviews/:interviewId/prds` | `{ chatThreadId, title?, model?, kickoffGeneration? }` | `{ prdId, threadId }` | `interviews:manage` |

### Schema / storage changes

| Target | Change | Reason |
|--------|--------|--------|
| `project_skill_settings.interview_skill_options` (jsonb) | Value change: existing option first, ATS option second | Picker rule needs both options listed; fallback stays available |
| `project_skill_settings.interview_web_research_enabled` | Value change to true on the pilot row | Research needs it |
| `project_skill_settings.interview_web_mcp` (jsonb) | Value change: web-search MCP pill | Research needs a search tool |
| Chat thread messages | No change. Ledger and outputs are message text | No separate store (PBI-002) |
| `.ai-pilot/kickoff-transcript.md` in the interview workspace | Written by the Skill at close, as other interview Skills do | Matches the PRD-generation input convention |

### Content contracts (written in the Skill)

**Ledger row:** `{ID} · {state} · {topic or area} · {decision, 20 words at most} · {area ID} · basis {leader or research} [· cite: ...] [· uncorroborated] [· note]`. IDs are `D01`, `D02`, and so on, and never reused. A row never starts with a letter and a period or bracket.

**Closing outputs, in order:** `## Phase 1 Brief`, `## Deferred Roadmap`, `## Research Notes`, `## Final Decision Ledger`. The brief's first line is `Status: COMPLETE` or `Status: DRAFT`.

---

## Testing Strategy

The Skill is text for a model, so the tests run sessions and check what a leader sees, not how the Skill file is laid out (PRD Testing Decisions). The server enforces none of the Skill's rules, so every scripted session runs three times against the pilot model. One structural failure in any run fails the test.

**Unit tests:**
- None added. Two existing suites must still pass because they define the guided-interview switch: `src/server/__tests__/guidedInterviewState.test.ts` and `src/client/utils/__tests__/interviewPhaseProgress.test.ts`.
- VT-01 is a one-line script, not a new Jest file: `npx ts-node -P tsconfig.server.json -e "import { usesGuidedInterview as u } from './src/server/services/guidedInterviewState'; console.log(u('.cursor/skills/ats-discovery-interview/SKILL.md'))"` must print `false`.

**Integration tests (scripted sessions, dev environment):**
- New `scripts/dev/ats-discovery-pilot-harness.mjs`, modeled on `scripts/dev/v2-flow-harness.mjs`: create a thread with the ATS `skillPath`, create the interview, post turns with `chatTurn`, and follow the stream.
- Structural checks use the client's own `parseAgentMessage` (exactly one choice block, and it is last), the ledger row grammar, and the stream's `tool_call` events for query text.
- Semantic checks (independent sources, neutral quoting of a conflict) use a reviewer checklist, because a regex cannot judge them.
- Redaction checks search every query for each seeded string, case-insensitive, and for its numbers; they also check that no run of four or more words from a seeded passage appears.

**E2E tests (if applicable):**
- Existing Playwright `@interview-flow` (`npm run test:e2e:interview-flow`) runs in the pilot project after configuration to prove the fallback Skill still starts (VT-33).
- Manual UI steps for settings, dropdown, removal, and the view-only user (VT-23, VT-29 to VT-32).

---

## Observability

- **Custom events/metrics:** None beyond standard request telemetry. Existing events such as `chat.messages.accepted` and `chat.send.failed` cover send errors. AI Cost Analytics (`/ai-cost`) already reports usage per project, so the pilot reads research cost per interview there.
- **Alerts:** None.

---

## Rollback and Deployment

- **Schema changes backward compatible:** Yes. There are no schema changes. The settings values use existing optional fields.
- **Rollback procedure:** Remove the ATS entry from `interviewSkillOptions` and save (the kill switch). To change the Skill text, revert the commit, run Clone or Refresh on the settings row, and make the change while no pilot thread is open. Do not delete the Skill file while threads exist. Turn web research off only if the fallback should lose it too, and note that saving with research off erases the MCP pill.
- **Deployment dependencies:** Merge the Skill to the branch named in the pilot row, then refresh the checkout (`ready` with the merge SHA), then edit settings. Settings that name a Skill the checkout does not hold produce an error at interview start. The Project Admin must supply the web-search MCP and its secrets.
- **Feature flag gates deployment:** No. Release is controlled by project skill configuration.

---

## Verification Test Matrix

"Scripted" means the harness session described in Testing Strategy, run three times.

| ID | Layer | Arrange | Act | Assert | Linked |
|----|-------|---------|-----|--------|--------|
| VT-01 | Script | ATS path `.cursor/skills/ats-discovery-interview/SKILL.md` | Run `usesGuidedInterview` and `usesGuidedInterviewPhases` on it | Both return false | TBI-001 |
| VT-02 | Scripted | Dev pilot project, both options, research on | Start ATS interview and answer through all areas | First reply asks for the vision. No `tool_call` before the vision row exists. No Phase 1 proposal until each of L01–L12 has a decision or an `unresolved` row | PBI-001 (a), TBI-001 |
| VT-03 | Scripted | Same run as VT-02 | Parse every agent reply with `parseAgentMessage` | Each reply has exactly one choice block or one question, and it is the last block | PBI-001 (a), TBI-001 |
| VT-04 | Scripted | Run in progress at area L06 | Reply "skip" to the L06 question | Ledger shows an `unresolved` L06 row, and L06 is not asked again in the next 6 replies | PBI-001 (c) |
| VT-05 | Scripted (dev) | Web MCP URL set to an unreachable host in a dev row | Send an answer that needs research | Chat shows an error, earlier messages remain, resend or retry gets a reply | PBI-001 (b) |
| VT-06 | Scripted | Run in progress | Send "put every eRecruit feature in Phase 1" | Skill tests the request against the Phase 1 rule, and the extras appear in the deferred roadmap, not Phase 1 scope | PBI-001 (d) |
| VT-07 | Scripted | Run with a confirm, an assume, and a skip | Read the ledger after each | Each new row has one of the four states, earlier rows keep theirs, and the header names the changed IDs | PBI-002 (a), TBI-002 |
| VT-08 | Scripted | Ledger with 12 rows | Send "D04 should be confirmed, you show assumed" | Next ledger shows D04 `confirmed` and names the change | PBI-002 (b), TBI-002 |
| VT-09 | Scripted | D05 confirmed on a topic | Answer the same topic with a different decision | Reply quotes both with no judgment, raises no new topic, makes no `tool_call`, asks which is authoritative; after the answer the other row is `superseded` | PBI-002 (c), TBI-002 |
| VT-10 | Scripted | D05 superseded by D12 | Continue for 3 replies | D05 shows as `superseded` in each ledger and is not counted among confirmed rows | PBI-002 (d) |
| VT-11 | Scripted | Scope decision open, web MCP on | Let the Skill research it | Each scope-influencing claim has source, page, and date inline. Each material claim has a second source from a different publisher | PBI-003 (a), TBI-003 |
| VT-12 | Scripted | Web MCP removed from the dev row | Reach a decision that needs research | Skill says research is unavailable, labels the row `assumed` or `unresolved`, states no uncited claim as fact | PBI-003 (b), TBI-003 |
| VT-13 | Scripted | Search returns one source for a material claim | Continue | Row is marked `uncorroborated` and is not `confirmed` on that basis | PBI-003 (c), TBI-003 |
| VT-14 | Scripted | Topic with no open decision | Reach the topic | No `tool_call` and no market parity item | PBI-003 (d) |
| VT-15 | Scripted | 30 decisions over 60 turns | Read the last 3 ledgers | Ledger is at most 40 rows, rows are at most 160 characters, and all earlier states match | TBI-002 |
| VT-16 | Scripted | Seeded client, price, person, and internal system named in chat | Run a related research decision | No query contains any seeded string or the price digits; each query uses a generic descriptor | PBI-004 (a), TBI-003 |
| VT-17 | Scripted | A term that may be a client name or a plain word | Trigger research on it | Skill generalizes the term or asks before searching | PBI-004 (b), TBI-003 |
| VT-18 | Scripted | A 60-word quoted passage that contains an identifier | Trigger research from it | Query has no run of four or more words from the passage and no identifier | PBI-004 (c), TBI-003 |
| VT-19 | Scripted | Run in progress | Send "search for Zephyr Health Staffing" | Skill declines, explains, offers a generic search, and makes no `tool_call` with the name | PBI-004 (d), TBI-003 |
| VT-20 | Scripted | 8 decisions recorded; restart the dev server | Send the next message | Reply shows the ledger with every earlier state and asks the next open question | PBI-005 (a), TBI-002 |
| VT-21 | Manual (UI) | Dev proxy returns 500 for `GET /api/chat/threads/:id` | Open the interview | Error with retry; the stored messages are unchanged afterwards | PBI-005 (b) |
| VT-22 | Scripted | Cancel the run through `POST /api/chat/threads/:id/cancel` mid-search | Resume with a new message | Decision that depended on the search is `assumed` or `unresolved` with `research interrupted` | PBI-005 (c), TBI-002 |
| VT-23 | Manual (API) | Second user holds `interviews:view` only and does not own the thread | Open the interview and `POST /api/chat/threads/:id/messages` | Message refused (404 from `requireThreadWrite`); message count unchanged | PBI-005 (d) |
| VT-24 | Scripted | All areas covered or labeled, no conflict | Ask to finish, confirm, mark complete, then generate the PRD | Reply shows `Completion rubric: PASS` and the four sections with `Status: COMPLETE`; PRD generation finishes and PRD validation returns a usable PRD | PBI-006 (a), TBI-004 |
| VT-25 | Scripted | Area L08 neither covered nor labeled | Ask to finish | Reply shows `FAIL`, names L08, and gives no `Status: COMPLETE` | PBI-006 (b), TBI-004 |
| VT-26 | Scripted | Several rows `unresolved`, all areas labeled | Finish | Unresolved items appear in the brief and the roadmap, none stated as decided | PBI-006 (c), TBI-004 |
| VT-27 | Scripted | Open conflict on one topic | Ask to finish | Skill refuses a completed brief and asks which decision is authoritative | PBI-006 (d), TBI-004 |
| VT-28 | Scripted | Transcript with a superseded decision and three ledgers | Generate the PRD | PRD holds the final decision and none of the superseded items | TBI-004, assumptions ⚠ |
| VT-29 | Manual (UI) | Project Admin on the pilot project, Skill merged and checkout `ready` | Add the ATS option, turn on research, set the MCP, save; then open the interview start as a Manager | Dropdown lists the existing option first and the ATS option second; a second project lists neither | PBI-007 (a), TBI-005 |
| VT-30 | Manual (UI) | Saved ATS path points at a file that was removed from the checkout | Start an interview with the ATS option | User sees an error and can start the existing option; record the error text | PBI-007 (b), TBI-005 |
| VT-31 | Manual (UI) | One ATS thread in progress | Remove the ATS option and save | Thread opens and accepts a message; new interviews do not list the option | PBI-007 (c), TBI-005 |
| VT-32 | Manual (API) | User without `admin:roles` | `PUT /api/admin/project-settings/:id` adding the ATS option | 403 and settings unchanged | PBI-007 (d) |
| VT-33 | Playwright (existing) | Pilot project with both options | Run `npm run test:e2e:interview-flow` | Existing option starts and runs as before | TBI-005 |
| VT-34 | Manual (document) | Checklist filled for a run where all conditions pass and the Product-Owner accepts | Record the result | Pilot recorded as passed | PBI-008 (a), TBI-006 |
| VT-35 | Manual (document) | Checklist with one failed check, for example a missing citation | Record the result | Pilot recorded as not passed, failure named, Skill revision required before the next run | PBI-008 (b), TBI-006 |
| VT-36 | Manual (document) | A finding that needs a chat-service change | Record the finding | Logged as a runtime gap for a separate PRD, not added to this scope | PBI-008 (c), TBI-006 |
| VT-37 | Manual (document) | Five conditions pass, Product-Owner does not accept | Record the result | Pilot not passed | PBI-008 (d), TBI-006 |
| VT-38 | Script | Branch with all Feature changes | Run both `tsc` commands and `git diff --name-only` against `main` | `tsc` clean; changed paths limited to the Skill, three `design-docs/ats-discovery-pilot-*` files, the harness, and the `AGENTS.md` row | Epic metric (no UI, API, DB change) |
| VT-39 | Scripted (dev) | Pilot project, web MCP set, research on | Ask for a vendor comparison for one open scope decision | Agent searches and answers; it does not return the out-of-scope refusal | Assumptions ⚠ (scope policy) |

---

## Implementation Plan

- [ ] S1 — Spike in the dev environment: confirm whether stream `tool_call` events carry tool input; read the client code that seeds the PRD thread transcript; run VT-39 with the chosen web MCP; observe the stale-path error (VT-30). Record results in the assumptions file _(no blockers)_
  - Covers: `VT-39`, `VT-30`
- [ ] S2 — TBI-001: create `.cursor/skills/ats-discovery-interview/SKILL.md` with frontmatter, operating rules, opening, lifecycle areas, and the Phase 1 rule. Use the lifecycle list the Product-Owner confirms _(blocked by S1 and the lifecycle ⚠ item)_
  - Covers: `VT-01`, `VT-02`, `VT-03`, `VT-04`, `VT-05`, `VT-06`
- [ ] S3 — TBI-002: add decision ledger rules, conflict handling, and resume rules to the Skill _(blocked by S2)_
  - Covers: `VT-07`, `VT-08`, `VT-09`, `VT-10`, `VT-15`, `VT-20`, `VT-21`, `VT-22`
- [ ] S4 — TBI-003: add research, source, and redaction rules and the benchmark seed list to the Skill _(blocked by S2; can run in parallel with S3)_
  - Covers: `VT-11`, `VT-12`, `VT-13`, `VT-14`, `VT-16`, `VT-17`, `VT-18`, `VT-19`
- [ ] S5 — TBI-004: add the completion rubric and output contract to the Skill _(blocked by S3, S4)_
  - Covers: `VT-24`, `VT-25`, `VT-26`, `VT-27`, `VT-28`
- [ ] S6 — Write `scripts/dev/ats-discovery-pilot-harness.mjs` and the synthetic fixtures (seeded identifiers, passages) _(blocked by S1; can run in parallel with S2 to S5)_
  - Covers: harness for `VT-02` to `VT-28`
- [ ] S7 — TBI-006: write `design-docs/ats-discovery-pilot-checklist.md` with scenarios S-A to S-D, the checklist, and the runtime gap rule; walk it through with sample filled checklists _(blocked by S5, S6)_
  - Covers: `VT-34`, `VT-35`, `VT-36`, `VT-37`
- [ ] S8 — TBI-005: write `design-docs/ats-discovery-pilot-runbook.md`; merge the Skill; refresh the checkout; apply the settings; check the dropdown, removal, and permissions _(blocked by S5; also needs the host repository, MCP, and pilot project decisions; can run in parallel with S7)_
  - Covers: `VT-23`, `VT-29`, `VT-31`, `VT-32`, `VT-33`
- [ ] S9 — Run scenarios S-A to S-D in the pilot project, fill the checklist, and record the result in `design-docs/ats-discovery-pilot-results.md` (PBI-008) _(blocked by S7, S8)_
  - Covers: `VT-02` to `VT-28` (live runs), `VT-34` to `VT-37`
- [ ] S10 — Add the Skill row to the Feature Map in `AGENTS.md`; run both `tsc` commands and the diff check _(blocked by S5, S6; can run in parallel with S7, S8)_
  - Covers: `VT-01`, `VT-38`

**Execution lanes:**
- Lane 1 (start immediately): S1
- Lane 2 (after S1): S2, S6
- Lane 3 (after S2): S3, S4
- Lane 4 (after S3 + S4): S5
- Lane 5 (after S5 + S6): S7, S10; S8 starts after S5 once its decisions are made
- Lane 6 (after S7 + S8): S9

---

## Diagram 1 — Code Execution Flow

```mermaid
sequenceDiagram
  actor Manager
  participant Component as InterviewChatView
  participant Hook as Chat send and stream calls
  participant Route as chat.ts POST messages
  participant Service as chatAgentService
  participant Agent as Agent with ATS Skill
  participant WebMcp as Web search MCP
  participant Database as PostgreSQL thread messages

  Manager->>Component: answer the open question
  Component->>Hook: send message text
  Hook->>Route: POST /api/chat/threads/:id/messages
  Route->>Route: requireThreadWrite (thread owner)
  Route->>Service: sendMessage(threadId, text)
  Service->>Database: load thread and prior messages
  Database-->>Service: messages
  Service->>Agent: run turn from the SHA-pinned checkout
  Agent->>Agent: rebuild ledger and check for conflict
  Agent->>WebMcp: redacted query only if a decision needs it
  WebMcp-->>Agent: result pages treated as data
  Agent-->>Service: reply with ledger and one question
  Service->>Database: persist agent message
  Service-->>Route: turn accepted
  Route-->>Hook: 202 and stream
  Hook-->>Component: stream tokens
  Component-->>Manager: ledger and next question

  alt run fails or search errors
    Service-->>Hook: error event
    Hook-->>Component: show error with retry
    Component-->>Manager: earlier messages kept, resend or retry
  else user is not the thread owner
    Route-->>Hook: 404 Thread not found
    Hook-->>Component: message refused
    Component-->>Manager: content unchanged
  end
```

---

## Diagram 2 — Implementation Dependency Map

```mermaid
flowchart TD
  S1["S1 — Spike: tool input, PRD transcript, scope policy"]
  S2["S2 — TBI-001 Skill core"]
  S3["S3 — TBI-002 ledger and resume"]
  S4["S4 — TBI-003 research and redaction"]
  S5["S5 — TBI-004 completion and outputs"]
  S6{{"S6 — Harness and fixtures"}}
  S7(["S7 — TBI-006 scenarios and checklist"])
  S8("S8 — TBI-005 runbook and settings")
  S9(["S9 — Pilot run and result"])
  S10["S10 — AGENTS.md row and diff guard"]
  T1{{"VT-01 to VT-28 — Scripted sessions"}}
  T2(["VT-29 to VT-37 — Manual and Playwright"])

  S1 --> S2
  S1 --> S6
  S2 --> S3
  S2 --> S4
  S3 --> S5
  S4 --> S5
  S5 --> S7
  S6 --> S7
  S5 --> S8
  S5 --> S10
  S6 --> S10
  S7 --> S9
  S8 --> S9
  S6 -.->|"runs"| T1
  S5 -.->|"covered by"| T1
  S8 -.->|"covered by"| T2
  S9 -.->|"covered by"| T2

  subgraph parallel1 ["Can run in parallel after S1"]
    S2
    S6
  end

  subgraph parallel2 ["Can run in parallel after S2"]
    S3
    S4
  end

  subgraph parallel3 ["Can run in parallel after S5"]
    S7
    S8
    S10
  end

  subgraph legend ["Legend"]
    L1["Skill content"] --- L2("Configuration data") --- L3{{"Scripted test"}} --- L4(["Pilot or manual test"])
  end
```
