# Assumptions & Unresolved Items — ATS Discovery Interview Skill

> **PRD slug:** `ats-discovery-interview-skill` | **Priority:** Must Have | **Feature flag:** `None`
> Shared between [design-doc-design.md](design-doc-design.md) and [design-doc-tech-spec.md](design-doc-tech-spec.md).
> Resolve all ⚠ items before implementation begins.

---

## Unresolved Items

Items that the PRD, backlog, and codebase (pinned SHA `f8b864fa49786a06963750a6327ed42db8e3eeaf`) could not settle. This run is non-interactive, so each item carries the default this spec applied. Step S1 in the tech spec's Implementation Plan is a short spike that closes the items marked "verify in S1".

- ⚠ **Lifecycle area list.** The PRD says the Skill defines the "full staffing lifecycle" areas from the ADR, and the ADR text was not available. TBI-001 requires the Skill to list every area, TBI-004 checks coverage against that list, and VT-02, VT-04, VT-24, and VT-25 count areas. The Product-Owner must confirm or edit the working list L01–L12 (tech spec, TBI-001) against the ADR before the Skill merges. *Default applied:* L01–L12 as written in the tech spec.

- ⚠ **Skill host repository and branch.** The agent loads the Skill from the `skillRepo` and `skillBranch` on the pilot project's skill settings row, through the SHA-pinned checkout. The PRD names no repository. This decides where TBI-001 commits and what S8 configures. The Project Admin must name the repository and branch for the pilot project. *Default applied:* author the Skill in the Apex repository at `.cursor/skills/ats-discovery-interview/SKILL.md`. If the pilot project points at another repository, copy the file there by pull request, at the same path.

- ⚠ **Web search server for the pilot.** The PRD says "enable web research." In code, research needs two settings: `interviewWebResearchEnabled` and an `interviewWebMcp` pill. `enrichKickoffForInterviewWebResearch` in `chatAgentService.ts` returns the kickoff unchanged when `interviewWebMcp` is empty, so no search tool and no scope carve-out reach the agent. The Project Admin must name the MCP server, its transport, and who holds its secrets. Without one, pass conditions 3 and 4 (citations, corroboration) cannot be met. *Default applied:* reuse the web-search MCP pill that other projects already use. If none exists, S8 stays blocked.

- ⚠ **Reading research queries for the leak test.** VT-16 to VT-19 must read the exact text the model sent to the search tool. The chat stream emits `tool_call` and `tool_status` events, but this spec did not confirm that they carry tool input, or that Postgres keeps it. The Skill also prints each redacted query in chat before it searches, but a printed query is not proof of what was sent. Verify in S1. *Default applied:* use stream tool events if they carry input, and the web MCP server's request log if they do not. If neither shows queries, pass condition "redaction" cannot be verified and the pilot cannot pass.

- ⚠ **Scope policy versus market research.** `buildScopePolicyLines` in `chatAgentService.ts` tells the agent to refuse general or public-data requests. The web-research carve-out allows research "in service of building this project." An ATS replacement may not be the pilot project's own product. `InterviewSkillOption` has no `bypassScopePolicy` flag (only `QuickSkillPill` has one). If the model refuses vendor research, pass conditions 3 and 4 fail and the Skill text cannot fix it. The Project Admin and Product-Owner must choose a pilot project for which ATS replacement counts as project or organisational work. Verify with a dry run in S1. *Default applied:* assume research is allowed. If the dry run is refused, log it as a runtime gap for a separate PRD (PRD out-of-scope rule).

- ⚠ **Who drives a leadership session.** Sending a message needs thread ownership (`requireThreadWrite` → `canWriteThread` in `chat.ts`; other users get a 404). Only the interview author can mark it complete (`updateInterviewStatus` throws 403 otherwise). The PRD assumes the Manager persona stands in for the COO and directors, but directors cannot type into a thread a Manager owns. This spec did not verify whether other leaders can open the interview read-only. Decide who owns the thread, and whether leaders attend while one Manager types. *Default applied:* one Manager (the interview author) drives each sitting with leaders present. Affects PBI-005 (a) and (d) and the pilot scenarios.

- ⚠ **Which transcript PRD generation reads.** `POST /api/interviews/:interviewId/prds` accepts a PRD chat thread that the client created with `kickoff.transcript`. This spec confirmed that `prdService.readInterviewTranscript` joins every user and agent message, and that an approved Interview Brief replaces the transcript only for playbook interviews. It did not read the client code that seeds the PRD thread. If the transcript holds every message, then every earlier ledger, including superseded decisions, reaches `to-prd`, which treats "every statement" in the transcript as authoritative scope. Verify in S1. *Default applied:* the closing reply ends with a "Final Decision Ledger" that states it overrides all earlier ledgers, and the Skill also writes `.ai-pilot/kickoff-transcript.md` with the same sections. If the PRD still carries superseded items, log a runtime gap.

- ⚠ **Design Prototype and Test Case stages for the ATS option.** Each `InterviewSkillOption` defaults `wantsDesignPrototype` and `wantsTestCases` to true, and the PRD is silent. The Product-Owner must decide whether a discovery interview should start those stages after PRD approval. *Default applied:* set both to `false` on the ATS option for the pilot, so the pilot ends at an accepted PRD. With `wantsTestCases: false`, no QA owner is assigned at kickoff.

---

## S1 resolutions (local implementation)

Verified against the repository before the Skill was written. Each ⚠ item above keeps its default. These notes record what the code showed.

- **Lifecycle area list.** Authoring uses L01–L12 from the tech spec. The Product-Owner still confirms that list before a wider rollout. The checklist is where that confirmation is recorded. No second list was invented.
- **Skill host.** The Skill is `.cursor/skills/ats-discovery-interview/SKILL.md` in this repository. Existing interview options use that path form without a leading slash (`e2eSetup.ts`, interview tests).
- **Web search server.** No pill is stored in the repo. `interviewWebMcp` is a per-project value edited in `AdminProjectSettings.tsx`. The runbook tells the Project Admin to reuse a pill another project already uses. Live research stays blocked until that pill exists. The Skill contains no secrets.
- **Reading research queries.** `summarizeCursorToolInput` in `cursorExecutionCore.ts` publishes tool input as key names or a type tag, not the query string. `summarizeMcpRpc` logs the method and tool name, not the arguments. The Skill therefore prints `Research status: searching "{redacted query}"` before it searches. Leak checks read that line and any string fields that do appear on tool events. The printed line is what the leader sees. It is not a capture of the bytes sent to the MCP. A wire log would be a runtime gap.
- **Scope policy.** No dry run was possible without a pilot MCP. The default stands: research is allowed when the carve-out is on. The runbook includes that dry run. A refusal is logged as a runtime gap. No server change.
- **Who drives.** One Manager, the interview author, types. `requireThreadWrite` is owner-only. The Skill and the runbook say other leaders attend while that Manager types.
- **Which transcript PRD generation reads.** `InterviewChatView` `handleGeneratePrd` puts every user and agent message into `kickoff.transcript`. `prdService.readInterviewTranscript` does the same. Superseded ledgers reach PRD generation. The closing reply and `.ai-pilot/kickoff-transcript.md` end with the Final Decision Ledger and the line that it overrides every earlier ledger. If a generated PRD still keeps superseded items, log a runtime gap. The client was not changed.
- **Design Prototype and Test Case stages.** The runbook sets `wantsDesignPrototype` and `wantsTestCases` to `false` on the ATS option. Both fields exist on `InterviewSkillOption` in `projectSettings.ts`.
- **Grounding caller.** `resolveGroundingCallerKey` returns `agent-home` for a path that does not contain `grill-with-docs`, `grill-design`, `kick-off`, or `adr-interview`. Web research still attaches when the path is listed in `interviewSkillOptions` (`enrichKickoffForInterviewWebResearch`). If a pilot run shows repository reads or a scope refusal the Skill text cannot stop, log a runtime gap. No service change in this feature.
- **Stale skill path.** When the file cannot be preloaded, `chatAgentService` tells the agent the skill file is missing. The live UI sentence was not observed. The runbook quotes that server instruction and asks the pilot to record the sentence the Manager sees.

## Assumptions Accepted

Inferences made during synthesis that were treated as resolved. Confirm these with stakeholders before implementation locks.

- **Separate Skill outside the guided-interview path.** `usesGuidedInterview` (server, `guidedInterviewState.ts`) and `usesGuidedInterviewPhases` (client, `interviewPhaseProgress.ts`) test whether the skill path contains `grill-with-docs`. A path without that text gets no server-controlled turn markers and no Discovery/Delivery/Technical phase bar. The ATS Skill path must therefore not contain `grill-with-docs`. *Derived from:* both functions at the pinned SHA. *Risk if wrong:* the server would force the six-topic Discovery plan on the ATS interview and close repository tools. *Consequence accepted:* the server does not enforce one question per reply, the ledger, or the completion rubric. The Skill text carries all three, so every test is behavioral and run three times (tech spec, Testing Strategy).

- **Both interview options must be listed.** `InterviewChatView.tsx` uses the fallback skill only when the project has zero `interviewSkillOptions`. With exactly one option it selects that option and hides the dropdown. With two or more it shows a dropdown and preselects the first. The pilot therefore lists the existing interview Skill first and the ATS Skill second. *Derived from:* `InterviewChatView.tsx` lines 387–395 and 736–761. *Risk if wrong:* adding only the ATS option silently removes the fallback, which breaks BR-009 and PBI-007 (a).

- **Web research is per settings row, not per Skill.** `interviewWebResearchEnabled` and `interviewWebMcp` sit on the `project_skill_settings` row, and `enrichKickoffForInterviewWebResearch` applies them to every path in `interviewSkillOptions`. Turning research on for the pilot also turns it on for the fallback Skill in that project. A separate settings row would isolate it, but adds a new checkout, approver pools, and a row picker at interview start. *Decision:* use the project's default row and accept the shared setting. *Risk:* fallback interviews in the pilot project can reach the web.

- **Admin save keeps the MCP only when research is on.** `AdminProjectSettings.tsx` writes `interviewWebMcp: edit.interviewWebResearchEnabled ? edit.interviewWebMcp : null`. Switching research off and saving erases the MCP pill. *Risk:* a later save with research off deletes the pilot's MCP choice; the runbook must say so.

- **Ledger format fits the chat parser.** `parseAgentMessage.ts` turns any run of two or more lines that start with `a.` to `e.` (or `A)`) into buttons, and takes the paragraph above the run as the question. Ledger lines therefore start with IDs such as `D07`, and the single question with its options is the last block of every reply. *Risk if wrong:* ledger lines render as answer buttons.

- **Full ledger in every reply.** Interview threads without a live agent are recovered from Postgres with `buildAgentRecoveryContext`, which keeps 100,000 characters: 30% from the start and 70% from the end, with the middle dropped. A reply that carries the whole ledger is self-contained after any recovery. Cap: 40 rows, one line each, 160 characters. Superseded rows shrink to a short line but stay. *Risk:* a very long session can still drop early quotes; the ledger rows carry the state, not the quotes.

- **Citations ride inside ledger rows.** Rows resting on research carry source, page, and month inline, so recovery cannot separate a claim from its source. The Research Notes section compiles them at the end.

- **Closing reply carries the outputs.** Chat messages are the only store that this spec confirmed survives for PRD generation, so the three outputs appear in the closing reply, and the Skill also writes `.ai-pilot/kickoff-transcript.md` as `adr-interview` does. *Risk:* see the transcript ⚠ item.

- **No repository reads inside the interview.** Non-guided threads have repository tools open. The Skill forbids them, because a leadership interview needs no code and the reads add latency. *Risk:* none for scope; the Skill gets product context from the conversation only.

- **The current ATS product name counts as an internal identifier.** The Skill researches "the current ATS" in generic terms unless the leader allows the name. This loses public documentation about the incumbent. *Risk if wrong:* weaker research on incumbent parity; the leader can allow the name per query.

- **Research limits are starting values.** Independent sources: different publishers that do not cite each other (two pages from one vendor count as one). At most 4 searches per reply and 3 queries per decision, so a reply finishes inside the agent run limits (`hard_timeout` and `progress_timeout` health states in `chat.ts`). Product-capability claims prefer sources from the last 24 months. The pilot tunes these values.

- **Benchmark seeds are an author's proposal.** The Skill carries a short list of public ATS products and public sources (tech spec, TBI-003) marked "Pilot review". The Product-Owner reviews it during the pilot, as the PRD requires. *Risk:* seeds bias research toward the products named.

- **Mark Complete is not gated.** The interview screen lets the author click Mark Complete at any time; the Skill cannot stop that. The Skill prints `Completion rubric: PASS` or `FAIL`, and the pilot checklist verifies that the interview was marked complete only after a PASS reply. *Risk:* PRD generation from a draft transcript; the DRAFT label in the output limits the damage.

- **Raw conversation keeps identifiers.** Redaction covers research queries and the three outputs. The stored conversation is out of scope (PRD) and follows existing interview storage. Identifiers a leader typed can still reach PRD generation through the transcript. *Risk:* an identifier appears in the PRD; the Product-Owner reviews the PRD before approval.

- **Edit the Skill only between pilot runs.** Repository grounding is SHA-pinned (`repositoryCheckoutSha`). This spec did not verify whether a resumed thread keeps its start SHA or takes a new one. The pilot therefore revises the Skill only when no pilot thread is open (consistent with PBI-008 (b): revise before the next run).

- **Checkout refresh follows every Skill merge.** `ProjectSkillConfig` carries `repositoryCheckoutStatus` and `repositoryCheckoutSha`, and repository-dependent AI is blocked with `PROJECT_REPOSITORY_NOT_READY` until an admin clones. After merging the Skill, the Project Admin runs Clone or Refresh on the pilot row and confirms `ready` with the merge SHA. *Risk:* the option lists a Skill the checkout does not yet hold.

- **A stale Skill path shows the existing error.** The options editor picks Skills from the checked-out repository, so a bad path arises only when the file moves or is removed after saving, or when the API is called directly. VT-30 records what the user sees. If the error is unclear, log it as a runtime gap.

- **Permission model is unchanged.** Start: `interviews:manage` plus the BA, Manager, or Product-Owner group (`POST /api/interviews`). Settings: `requirePermission('admin:roles')` on `admin.ts`. View-only users who do not own the thread get the existing refusal (404 "Thread not found"), not a permission message. Product-Owner acceptance of the pilot is a manual checklist entry; the Apex `prds:review` approval is a separate step. *Risk:* none for security; the refusal text is blunt.

- **Pilot project named before S8.** The Project Admin and Product-Owner choose it (PRD assumption). S8 cannot start without it.

- **Pilot results live in one markdown file.** Default: `design-docs/ats-discovery-pilot-results.md` in the skill repository, written through a pull request, with sources and dates but no identifiers. *Risk:* none; any reader can open it.

- **A small dev harness is acceptable.** Scripted sessions need repeatable runs after each Skill revision. The spec proposes `scripts/dev/ats-discovery-pilot-harness.mjs`, modeled on `scripts/dev/v2-flow-harness.mjs`. It is test tooling, not runtime code. *Risk if wrong:* the repository owner rejects new scripts; fall back to manual runs with the same scenario files.

- **Phase 1 test.** The Skill defines "smallest usable end-to-end workflow" as: remove any item, and if one real piece of work can still go from first input to final output, the item is deferred. This is the author's wording of BR-006.

- **Documentation row.** After the Skill merges, add one row for it to the Feature Map in `AGENTS.md` so agents can find it. *Risk:* `AGENTS.md` guidance says agents do not edit it unless told; the repository owner approves this one-line edit.
