<!-- apex-grounded-sha:f8b864fa49786a06963750a6327ed42db8e3eeaf -->

> Based on the **Apex** project, **main** branch, as of Oct 17, 2026.
---
title: ATS Discovery Interview Skill
slug: ats-discovery-interview-skill
created: 2026-10-17
triage-status: needs-triage
glossary-terms-used:
  - Interview
  - PRD
  - Backlog
  - Skill
  - PBI
  - TBI
  - Feature Flag
  - Project Admin
---

# ATS Discovery Interview Skill

## Problem Statement

Leadership wants to replace the current ATS (the eRecruit system) to save money and gain control. No one has agreed what the first release of a replacement should contain. Without a guided process, leaders may default to copying every feature of the old system or the market, and the decisions they reach are hard to trace or turn into a PRD.

## Solution

Apex gets one new Skill, the ATS discovery interview, that a Manager can run as a project-scoped Interview. It starts from leadership's vision, then uses focused market research to test each decision. It covers the full staffing lifecycle but narrows Phase 1 to the smallest usable end-to-end workflow. The Skill keeps a visible ledger of decisions, redacts sensitive detail before any research, cites the sources behind scope decisions, and ends with a Phase 1 brief, a deferred roadmap, and research notes that feed PRD generation. A Project Admin enables it for a pilot project through project skill settings, and the existing interview Skill stays available as the fallback.

This work delivers the Skill, not the ATS itself.

## Implementation Decisions

**Approach.** Extend Apex's existing guided-interview pattern. A project setting already selects the interview Skill and turns on web research; the chat service loads that Skill; the interview service and chat threads store and resume the conversation. The ATS discovery Skill plugs into that pattern. Runtime work happens only if the pilot shows the current flow cannot meet a requirement.

**Modules to build**

- **ATS discovery Skill definition (deep module).** One Skill document that owns the whole procedure behind a single entry point: the user starts it like any other interview Skill. It reads the conversation so far, asks one question at a time, and returns the next question plus an updated ledger. It opens with leadership's vision, covers each stage of the staffing lifecycle, tests decisions with research, and narrows Phase 1 to the smallest usable end-to-end workflow. It does not drive a feature-parity checklist.
- **Decision ledger rules.** A section of the Skill that defines four decision states (confirmed, assumed, unresolved, superseded), how each reply shows the current ledger, and how a conflict between two decisions pauses the interview until the leader names the authoritative one. The ledger lives in the reply text and is written into the standard interview transcript at the end. No separate store.
- **Research and redaction rules.** A section that sets when research is allowed (only when it informs a decision under discussion), what must be redacted first (personal, client, commercial, and internal identifiers), which sources count, and what to record (source and date). Claims that influence scope carry a citation. Material claims need corroboration. Benchmark seeds (starting examples for research) are reviewed during the pilot.
- **Completion rubric and output contract.** A section that decides when the session can finish and what it produces: a Phase 1 brief, a deferred roadmap, and research notes, written in the form PRD generation reads. A session with an uncovered lifecycle area that is not labeled unresolved, or with unresolved conflicts, stays a draft.
- **Pilot configuration and acceptance checklist.** A runbook that registers the Skill as an interview Skill option for one pilot project through existing project skill settings, enables web research for that project, keeps the existing interview Skill as fallback, and lists the pass conditions below.

**Existing modules reused without change**

- Guided-interview flow and streaming chat (create, stream, resume, complete).
- Interview and chat thread persistence, which hold the transcript and the ledger text.
- Project skill settings, which choose the interview Skill, the model, and web research per project.
- Authentication, project scope, and the existing interview view and manage permissions.
- PRD generation, which reads the finished transcript.

**Interfaces**

- Input: the interview conversation, project-configured model, and project-configured web research access.
- Output: streamed replies that end with one question and the current ledger; at completion, a transcript containing the Phase 1 brief, deferred roadmap, and research notes.
- Side effects: none beyond existing thread and transcript writes. No schema, API, UI, or server service changes.

**Pilot acceptance.** The pilot passes only if all of these hold:

1. Every lifecycle area is covered or carries an explicit unresolved label.
2. Decisions are retained correctly across the session.
3. Influential claims are cited.
4. Material claims are corroborated.
5. A session resumes successfully after a break.
6. The product owner accepts the PRD-ready output.

There is no numeric score threshold.

**Risk mitigations.** The ADR's negative consequences cannot be removed, but each has a control: research only when relevant; source and date recorded; redaction required; benchmark seeds reviewed in the pilot; sessions resumable; completion tied to the acceptance checks. Research variability and imperfect redaction remain open risks.

## Testing Decisions

- **What makes a good test here:** Test what a leader or product owner sees in a session, not how the Skill text is organized. Tests should prove that decisions keep their state across turns and after resume, that conflicts pause the interview, that redacted text never reaches a research query, that scope-changing claims show a citation, and that an incomplete session produces a draft while a complete one produces the three outputs.
- **Modules to test:**
  - ATS discovery Skill definition — run scripted sessions against the existing interview flow and check each reply.
  - Decision ledger rules — scripted sessions that confirm, assume, skip, supersede, and contradict decisions.
  - Research and redaction rules — seeded inputs containing personal, client, commercial, and internal identifiers; inspect the research queries for leaks.
  - Completion rubric and output contract — feed the finished transcript to PRD generation and check the PRD is usable.
  - Pilot configuration — confirm the Skill appears only in the pilot project and the fallback Skill still starts.
- **Prior art:** Existing interview Skills are exercised through the guided-interview flow, and PRD generation is exercised from a finished interview transcript. Reuse those paths. Permission checks follow the existing view versus manage pattern.

## Target Surface

- **Primary surface:** Skill content only. The Skill runs inside the existing interview experience, so there is no new frontend, backend, shared type, or database work. Project skill settings configuration is a data change by a Project Admin.
- **Experience notes:** Leaders use the existing interview chat. Each reply ends with one question and a visible decision ledger.

---

## Access Control and Permissions

| Action | Required group(s) / role(s) | Data scope |
|--------|---------------------------|-----------|
| Start and run an ATS discovery Interview | Existing interview rules: BA, Manager, or Product-Owner group, with the interview manage permission | Project-scoped |
| Read an ATS discovery Interview and its outputs | Interview view permission | Project-scoped |
| Resume an in-progress ATS discovery Interview | Same as start | Project-scoped |
| Enable or remove the ATS discovery Skill option for a project | Project Admin | Project-scoped |
| Accept or reject the pilot output | Product-Owner | Project-scoped |

---

## Security and Data Sensitivity

- **Sensitive fields:** ATS context may include personal data (candidates, staff), client names, commercial terms (pricing, contracts), and internal identifiers (system names, vendor account details). Treat all of it as potentially sensitive.
- **Handling requirements:** Redact personal, client, commercial, and internal identifiers before any web research query. Stored conversation follows existing interview storage handling. Research notes record sources and dates, not redacted details.
- **Data scope enforcement:** The Skill uses existing project scope and interview permissions. An interview belongs to one project, and the Skill adds no new data path.

---

## Non-Functional Requirements

- **Response time:** Not specified — agent assumed the existing interview streaming behavior is acceptable, and research must not stall a reply without a visible status.
- **Concurrency:** Not specified — the pilot runs one project-scoped leadership interview at a time.
- **Data volume:** Not specified — the ledger and research notes must stay small enough to carry through one interview thread and resume without loss.

---

## Feature Flag

- **Flag required:** No
- **Flag name:** None
- **Rollout sequence:** Not applicable. Release is controlled by project skill configuration: pilot project first, then wider use after acceptance.
- **Kill switch owner:** Project Admin, by removing the ATS discovery Skill option from project skill settings.
- **Behavior when disabled:** The ATS discovery option does not appear for the project, and the existing interview Skill works as before.

---

## Out of Scope

- Building, buying, or migrating to the replacement ATS itself.
- New UI, new API endpoints, database tables or migrations, or an ATS-specific server service.
- Adding ATS logic to the existing general interview Skill.
- A new interview approach or an external system to store decisions.
- A feature-parity checklist against eRecruit or the market.
- A quantitative score threshold for pilot acceptance.
- Runtime changes to the interview flow, unless the pilot shows the current flow cannot meet a requirement. Those would need their own PRD.
- Changes to Azure DevOps work items.

## Assumptions Made

- The Manager persona stands in for the COO and directors who take part in the leadership interview, because Apex has no separate executive group.
- The Product-Owner persona accepts the pilot output, as the transcript names the product owner as the acceptor.
- The ADR "ATS System - product interview full scope (research-grounded-ats-discovery-skill)" is accepted, and its decisions are those in the kickoff transcript. Its full text was not available during synthesis.
- Existing project skill settings can already register an additional interview Skill option and turn on web research per project, and the chat service passes that research access to the Skill.
- Redaction is done by the Skill's instructions to the model. It reduces risk but cannot guarantee that no identifier reaches a research query.
- "Benchmark seeds" means a short starting list of ATS products and public sources the Skill uses to begin research, reviewed by the product owner during the pilot.
- "Material claim" means a claim that would add, remove, or defer a Phase 1 scope item. "Corroboration" means support from at least one additional independent source.
- The "full staffing lifecycle" areas are defined inside the Skill from the ADR and kickoff; the PRD does not list them.
- The pilot project is chosen by the Project Admin and product owner before the pilot starts.
- Incomplete sessions stay as drafts in the existing in-progress interview state, and the existing mark-complete action is used only after the completion rubric is met.
