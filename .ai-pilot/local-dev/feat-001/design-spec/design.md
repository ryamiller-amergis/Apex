# Design — ATS Discovery Interview Skill

> **PRD slug:** `ats-discovery-interview-skill` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** ATS Phase 1 MVP Discovery | **Affected personas:** Manager, Product-Owner, Project Admin
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (8 unresolved)

---

## Feature Summary

**Description:** Leadership wants to replace the eRecruit ATS to save money and gain control, but no one has agreed what the first release must contain. This Feature adds one Skill, the ATS discovery interview, that a Manager runs as a project-scoped Interview. It starts from leadership's vision, tests each decision with cited research, keeps a visible ledger of decisions, redacts sensitive detail before any search, and ends with a Phase 1 brief, a deferred roadmap, and research notes that PRD generation reads. A Project Admin enables it for one pilot project, and the existing interview Skill stays as the fallback. The Feature delivers the Skill, not the ATS.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| PBI-001 | PBI | Shape a Phase 1 MVP through a guided leadership interview | Must Have |
| PBI-002 | PBI | Keep a visible ledger of decisions | Must Have |
| PBI-003 | PBI | Test Phase 1 decisions with cited research | Must Have |
| PBI-004 | PBI | Keep sensitive ATS details out of web research | Must Have |
| PBI-005 | PBI | Pause and resume an ATS interview without losing decisions | Must Have |
| PBI-006 | PBI | Receive a PRD-ready Phase 1 brief, deferred roadmap, and research notes | Must Have |
| PBI-007 | PBI | Enable the ATS discovery Skill for the pilot project | Must Have |
| PBI-008 | PBI | Accept or reject the ATS discovery pilot | Must Have |
| TBI-001 | TBI | Author the ATS discovery Skill definition and interview flow | Must Have |
| TBI-002 | TBI | Define decision ledger rules and conflict handling | Must Have |
| TBI-003 | TBI | Define research, source, and redaction rules | Must Have |
| TBI-004 | TBI | Define completion rubric and PRD-ready output contract | Must Have |
| TBI-005 | TBI | Configure the pilot project and fallback | Must Have |
| TBI-006 | TBI | Define pilot scenarios and acceptance checklist | Must Have |

---

## Scope and Out-of-Scope

**In scope:**
- One new Skill document that runs inside the existing Interview chat. It opens with leadership's vision (PBI-001, TBI-001), asks one question per reply, and covers each staffing lifecycle area or labels it unresolved.
- Ledger rules: four decision states (confirmed, assumed, unresolved, superseded), a visible ledger in every reply, and a pause on conflict until the leader names the authoritative decision (PBI-002, TBI-002).
- Research and redaction rules: research only when it informs an open decision, redaction before every query, source and date on every recorded claim, citation on claims that influence scope, corroboration on material claims, and a benchmark seed list for pilot review (PBI-003, PBI-004, TBI-003).
- Pause and resume through the existing thread storage, with the ledger rebuilt from the conversation (PBI-005, TBI-002).
- Completion rubric and output contract: Phase 1 brief, deferred roadmap, and research notes in the transcript; incomplete sessions stay drafts (PBI-006, TBI-004).
- Pilot configuration through existing project skill settings: ATS option beside the existing interview option, web research on, removal steps (PBI-007, TBI-005).
- Pilot scenarios and an acceptance checklist with pass or fail checks and no numeric score (PBI-008, TBI-006).

**Out of scope:**
- Building, buying, or migrating to the replacement ATS itself.
- New UI, new API endpoints, database tables or migrations, new settings screen, or an ATS-specific server service.
- Adding ATS logic to the existing general interview Skill.
- A new interview approach, or an external system to store decisions; a separate ledger table or screen; export of the ledger or the outputs outside Apex.
- A feature-parity checklist against eRecruit or the market.
- A quantitative score threshold for pilot acceptance; automated pilot scoring.
- Runtime changes to the interview flow, unless the pilot shows the current flow cannot meet a requirement. Those need their own PRD.
- Changes to Azure DevOps work items.
- Research on topics unrelated to a Phase 1 decision; automatic scoring of vendors.
- Automated scanning tools outside the Skill instructions; redaction of the stored interview conversation.
- Resume across projects; merging two interviews; automatic PRD approval.
- Enabling the Skill in all projects at once.

---

## Target Surface

**Primary surface:** Skill content only. The Skill runs inside the existing Interview experience, so this Feature adds no frontend, backend, shared type, or database work. Project skill settings configuration is a data change that a Project Admin makes in the existing Project Settings screen.

**Experience notes:** Leaders use the existing interview chat. Each reply shows the decision ledger and ends with one question. The chat view shows no Discovery, Delivery, or Technical phase bar for this Skill, because that bar belongs to the guided interview. The ledger replaces it as the progress view.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Start and run an ATS discovery Interview | BA, Manager, or Product-Owner group, with the `interviews:manage` permission (existing interview rules) | Project-scoped |
| Read an ATS discovery Interview and its outputs | Interview view permission (`interviews:view`) | Project-scoped |
| Resume an in-progress ATS discovery Interview | Same as start. The thread owner sends messages | Project-scoped |
| Mark the Interview complete | The interview author | Project-scoped |
| Enable or remove the ATS discovery Skill option for a project | Project Admin (`admin:roles`) | Project-scoped |
| Accept or reject the pilot output | Product-Owner. This is a checklist entry, not an Apex action | Project-scoped |

The Feature adds no permission, role, or group. A user who only holds `interviews:view` and does not own the thread cannot send messages; the existing thread check refuses the message and leaves the content unchanged.

**Feature flag:** `None` — rollout: pilot project first through project skill configuration, then wider use after the Product-Owner accepts the pilot.
**Behavior when flag is off:** Not applicable. The Project Admin's kill switch is removing the ATS option from project skill settings. The ATS option then disappears for new interviews, the existing interview Skill works as before, and interviews already in progress stay readable.

---

## Acceptance Criteria

### PBI-001 — Shape a Phase 1 MVP through a guided leadership interview

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A Manager with interview manage permission has the ATS discovery Skill enabled in the project | The Manager starts an ATS discovery Interview | The Skill opens by asking for leadership's vision, asks one question per reply, and works through every staffing lifecycle area before proposing Phase 1 |
| (b) Error/failure | An ATS discovery Interview is in progress | A reply cannot be generated because the model or research step fails | The user sees an error in the chat, the thread keeps all earlier messages, and the user can resend or continue |
| (c) Edge case/boundary | Leadership cannot answer a lifecycle area | The Manager chooses to skip it | The area is recorded as unresolved and the interview moves on without asking again |
| (d) Negative scenario | Leadership asks to include every feature of the old system or the market in Phase 1 | The Manager submits that request | The Skill tests it against the smallest usable end-to-end workflow, and items outside that workflow go to the deferred roadmap rather than a parity checklist |

### PBI-002 — Keep a visible ledger of decisions

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A decision has just been made in the interview | The Skill replies | The reply shows the decision with its state, and earlier decisions keep their states |
| (b) Error/failure | The ledger is being rebuilt from a long conversation | The model drops or misstates an earlier decision | The Manager can correct it in chat and the Skill restores the correct state in the next reply |
| (c) Edge case/boundary | Two decisions are recorded for the same topic | The Manager gives a new answer that conflicts with an earlier one | The Skill quotes both without judgment, pauses, asks which is authoritative, and marks the other superseded |
| (d) Negative scenario | A decision was marked superseded | The ledger is shown again | The superseded decision stays visible as superseded and is never counted as confirmed |

### PBI-003 — Test Phase 1 decisions with cited research

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A decision about Phase 1 scope is ready to test and research is enabled for the project | The Skill researches it | Each claim that influences scope shows a source and date, and each material claim shows a second independent source |
| (b) Error/failure | Web research is unavailable or returns nothing useful | The Skill tries to test a decision | The Skill says so, labels the decision as assumed or unresolved, and does not state an uncited claim as fact |
| (c) Edge case/boundary | A material claim has only one source | The Skill prepares to rely on it | The claim is marked uncorroborated and cannot support a confirmed decision until a second independent source is found |
| (d) Negative scenario | A topic has no bearing on any open decision | The interview reaches that topic | The Skill makes no research call and does not add a parity item from the market |

### PBI-004 — Keep sensitive ATS details out of web research

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | The Manager has named a client, a contract price, a person, and an internal system in the interview | The Skill runs a research query about a related decision | The query uses generic descriptions in place of every one of those identifiers |
| (b) Error/failure | The Skill cannot tell whether a term is an identifier | It prepares a research query containing that term | It treats the term as an identifier, generalizes it, or asks the Manager before searching |
| (c) Edge case/boundary | An identifier appears inside a longer quoted passage | The Skill builds a query from that passage | Only the generalized idea is searched and no part of the passage is copied |
| (d) Negative scenario | The Manager asks the Skill to search for a named client or person directly | The Skill receives the request | It declines to search with the name, explains why, and offers a generic search instead |

### PBI-005 — Pause and resume an ATS interview without losing decisions

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | An ATS discovery Interview is in progress with several decisions recorded | The Manager returns later and resumes the interview | The Skill shows the ledger with every decision in its earlier state and asks the next open question |
| (b) Error/failure | The thread cannot be loaded on resume | The Manager opens the interview | The user sees an error with a way to retry, and no earlier decisions are lost from storage |
| (c) Edge case/boundary | The interview ended mid-research on the previous sitting | The Manager resumes | The Skill labels the affected decision as assumed or unresolved until it can be tested again |
| (d) Negative scenario | A user with interview view permission only opens the interview | The user tries to send a message | The message is refused and the interview content stays unchanged |

### PBI-006 — Receive a PRD-ready Phase 1 brief, deferred roadmap, and research notes

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | Every lifecycle area is covered or labeled unresolved and no conflict is open | The Manager confirms the final brief and the interview is completed | The transcript holds a Phase 1 brief, a deferred roadmap, and research notes, and PRD generation can read it |
| (b) Error/failure | A lifecycle area is neither covered nor labeled unresolved | The Manager asks to finish | The Skill names the gap and the session stays a draft until it is covered or labeled unresolved |
| (c) Edge case/boundary | Leadership stops with several decisions unresolved but all areas labeled | The interview completes | The unresolved items are listed in the brief and the deferred roadmap, not stated as decided |
| (d) Negative scenario | An open conflict exists between two decisions | The Manager asks to finish | The Skill refuses to produce a completed brief and asks which decision is authoritative |

### PBI-007 — Enable the ATS discovery Skill for the pilot project

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A Project Admin is in project skill settings for the pilot project | The admin adds the ATS discovery Skill as an interview option and enables web research | A Manager in that project can choose it when starting an interview, and the existing interview Skill is still listed |
| (b) Error/failure | The admin enters a Skill path that does not exist in the configured repository | A Manager starts an interview with that option | The user sees a clear error and can start the existing interview Skill instead |
| (c) Edge case/boundary | Interviews are already in progress with the ATS discovery Skill | The admin removes the option | The in-progress threads remain readable and new interviews no longer offer the option |
| (d) Negative scenario | A user without Project Admin rights opens project skill settings | The user tries to add the ATS discovery Skill | The change is refused and the settings stay unchanged |

### PBI-008 — Accept or reject the ATS discovery pilot

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A pilot interview has finished and the checklist is filled in | All six pass conditions are met and the Product-Owner accepts the PRD-ready output | The pilot is recorded as passed and wider use may be planned |
| (b) Error/failure | A pass condition fails, such as a missing citation or a failed resume | The Product-Owner reviews the checklist | The pilot is recorded as not passed, the failure is named, and the Skill is revised before another pilot run |
| (c) Edge case/boundary | The pilot shows a requirement the existing runtime cannot meet | The Product-Owner records the finding | It is logged as a runtime gap for a separate PRD and is not added to this scope |
| (d) Negative scenario | Five conditions pass but the Product-Owner does not accept the output | The Product-Owner records the result | The pilot is not passed, because acceptance cannot be replaced by a score or by the other conditions |

**Technical work items.** TBI-001 to TBI-004 build the Skill sections that deliver PBI-001 to PBI-006. TBI-005 delivers PBI-007. TBI-006 and PBI-006 deliver PBI-008. Their definitions of done are in the technical specification.

---

## UI/UX

**Not applicable.** This Feature adds no route, screen, or component. The Skill shapes what appears inside the existing interview chat; the reference below is a content contract for the Skill author and reviewers.

**Reply anatomy (existing chat view):**

| Order | Block | Rule |
|-------|-------|------|
| 1 | Short acknowledgement | Two sentences at most |
| 2 | Research status line | Present only when a search is running or just ended. Shows the redacted query before the search starts |
| 3 | Decision ledger | Every decision on its own plain-text line: ID, state, topic, decision. Rows that rest on research carry source, page, and month |
| 4 | One question | Always the last block. Lettered answers (`a.` to `d.`) render as buttons; the last answer is `Skip — decide later`, except on a conflict question |

**States the user sees:**
- **Running:** the existing streaming reply and run-status display. A reply that searches shows the research status line first.
- **Error:** the existing chat error with resend or retry (PBI-001 b, PBI-005 b).
- **Paused on conflict:** the reply quotes both decisions, asks which is authoritative, and raises no new topic.
- **Draft:** the closing reply says `Status: DRAFT` and tells the leader not to mark the interview complete.
- **Complete:** the closing reply says `Status: COMPLETE` and holds the three outputs and the final ledger.

**Validation rules:**
- Decision state: exactly one of confirmed, assumed, unresolved, superseded. A conflict is a note on a row, not a fifth state.
- Citation: source, page, and month on every claim that influences scope; a second independent source on every material claim.
- Query: generic wording only. No name, contract term, price, system, or account detail from the conversation.
- Completion: all lifecycle areas covered or labeled unresolved, no open conflict, and citation and corroboration rules met.

**Accessibility:**
- The ledger, citations, and redaction notices are plain text, so screen readers read them like any other message. The Skill uses no tables, color, or symbols to carry meaning.
- Keyboard and screen reader behavior stay those of the existing chat view and Project Settings screen.

**data-testid attributes:**
- No new `data-testid`. Pilot tests use the existing Project Settings ids `ps-interview-options-editor`, `ps-interviewWebResearchEnabled`, and `ps-interview-web-mcp-editor`.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
