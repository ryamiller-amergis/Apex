<!-- apex-grounded-sha:e2f31fff9dbab5ff75b262c4ae5c3b52ff80711a -->

> Based on the **Apex** project, **main** branch, as of Sep 1, 2026.
---
title: Start Cloud Development from My Work
slug: start-cloud-development-from-my-work
created: 2026-09-01
triage-status: needs-triage
glossary-terms-used:
  - My Work
  - Feature Flag
  - PBI
  - TBI
  - Skill
  - ADR
  - Platform Admin
---

# Start Cloud Development from My Work

## Problem Statement

Developers on ADO-configured My Work rows have no way to hand a qualifying work item to an AI agent that implements it, runs checks, and opens a pull request. Today's Start Development is a local, in-app-workspace session the developer drives by hand from inside Apex. There is no durable, event-driven way to track a long-running implementation on the row itself, so a developer either keeps checking Azure DevOps manually or loses track of whether a run is stuck, finished, or never opened a pull request at all.

## Solution

A Developer can click **Start Cloud Development** on an eligible ADO My Work row to hand the work item to a Cursor Cloud Agent, then watch the run move through queued, starting, running, and a finished state directly on that row — including an honest **"Run finished, no PR yet"** when no pull request comes back. The agent runs unit, e2e, and WCAG checks and opens a pull request that is automatically linked to the work item and reflected back onto it as a host-agnostic **none / open / merged** status; failing checks show next to the PR link instead of blocking it. A Developer can **Cancel** a live run or **Resume** after any terminal outcome without leaving the row, and remaining issues stay on that same row and session instead of spawning new work items.

## Implementation Decisions

- **`cloudAgentService` (deep module).** Owns Start, Resume, status, and Cancel for Cloud Agent runs behind a simple interface. It evaluates the six Start eligibility conditions (flag on, ADO-configured project, Developer + self-only, existing dev-start eligibility, complete host-agnostic skill settings, no live run on the session), enqueues a new run through the existing run lifecycle service under a dedicated implementation workflow class, tracks the Cloud Agent identity once assigned, and requests cancellation — locally for a run with no Cloud Agent identity yet, cooperatively for a run already dispatched or running. Callers depend only on this service's start/status/cancel interface, never on run-lifecycle or eligibility internals directly.
- **Run lifecycle service (existing, extended).** Gains a Cloud-Agent-aware discriminator so implementation runs share the same enqueue / transition / markTerminal machinery already used by generation runs. A dedicated once-written identity marker excludes a run from the shared background in-flight cap and from heartbeat/progress reaping once its Cloud Agent identity is confirmed; a run still waiting for that identity keeps a bounded queue time-to-live so a stalled start cannot hold a slot indefinitely.
- **Webhook completion receiver (new, thin module).** Accepts a signed completion callback identified by the Apex run id embedded in its URL path, verifies the signature against a project-scoped shared secret, and hands the mapped status, PR URL, branch, and summary to the run lifecycle service's terminal write. It never trusts a run or agent identifier carried inside the payload body.
- **Eligibility evaluation (extended).** The existing dev-start eligibility check gains the Cloud Agent flag state, the host-agnostic skill-repo/branch completeness check, and the live-run check, so one evaluation backs both the disabled-button tooltip on the row and the server-side guard on the start endpoint.
- **My Work workbench routes (extended).** Vendor-neutral start, status, and cancel endpoints are added to the existing router, guarded by the same permission, group-membership, and author-only checks as every other session endpoint already on that router.
- **Session/run status projection (extended).** The existing session read model gains a nested current-run summary — status, PR URL, whether the run finished without a PR, terminal reason, and failing-check summary — so the client renders the full row state matrix from a single poll response.
- **My Work row UI and hooks (extended).** The existing row-action component and its data-fetching hooks gain Start / Resume / Cancel controls and the polling behavior needed to move through the state matrix, reusing the row's existing badge and button patterns rather than introducing a new page or a chat-style stream.
- **ADO/GitHub work-item outcome writer (extended).** The existing pull-request write path gains a step that stamps the work-item reference onto the pull request (a native Azure Repos work-item link, or an `AB#{workItemId}` mention on GitHub) and copies the resulting PR URL and host-agnostic status back onto the ADO work item, reusing the ADO write path already used for PR creation on this router.

## Testing Decisions

- **What makes a good test here:** Assert the observable row state (badge copy and available action) for every entry in the state/action matrix, not internal service call counts. Assert eligibility outcomes (enabled/disabled plus reason) against the six documented conditions, not the internal evaluation order. Assert the one-live-run rule produces a conflict response without depending on the exact database fencing mechanism. Assert webhook completion is idempotent and rejects an unsigned or mis-signed payload without asserting internal signature-library calls.
- **Modules to test:**
  - `cloudAgentService` — the deep module that owns eligibility, one-live-run enforcement, and host-agnostic launch; its behavior should be provable at its boundary.
  - Webhook completion receiver — signature verification and idempotent terminal writes are durability- and security-critical.
  - My Work row component — the state/action matrix is the feature's most user-visible contract.
- **Prior art:** The existing dev-start eligibility function is already tested as a pure function against representative work-item shapes. The existing run lifecycle service's transition and markTerminal functions are already tested for idempotency and illegal-transition rejection; the Cloud Agent path should mirror that pattern rather than duplicate it.

## Target Surface

- **Primary surface:** Full-stack (both client and server)
- **Experience notes:** All Cloud Agent status stays on the existing ADO My Work row inside the workbench view. There is no new page, no in-app chat panel, and no SSE stream for Cloud Agent output — status arrives through the existing session poll.

---

## Access Control and Permissions

| Action | Required group(s) / role(s) | Data scope |
|--------|---------------------------|-----------|
| Start Cloud Development | Developer group + `dev-workbench:view` permission | User-scoped (self-only) |
| Resume after a terminal run | Developer group + `dev-workbench:view` permission | User-scoped (self-only) |
| Cancel a live run | Developer group + `dev-workbench:view` permission | User-scoped (self-only) |
| View run status and PR status on a row | Developer group + `dev-workbench:view` permission | User-scoped (self-only) |
| Bypass ADO work-item type/origin eligibility (not run ownership) | Platform Admin | Project-scoped eligibility check only; Start/Resume/Cancel stay self-only |

---

## Security and Data Sensitivity

- **Sensitive fields:** ADO work-item id/title (and any description or acceptance criteria included in the run prompt), the run's execution snapshot prompt, `skillRepo` / `skillBranch`, the pull-request URL, the authoring developer's id, and the Cloud Agent's own identity once assigned.
- **Handling requirements:** Vendor credentials (the project-scoped Cursor service account / API key reference) are resolved server-side only and never sent to the browser. Snapshot/prompt content is excluded from lifecycle logs, consistent with existing run lifecycle logging. Webhook payloads are verified by HMAC signature before any lifecycle state is touched. ADO and GitHub writes stay scoped to the project's configured skill repository.
- **Data scope enforcement:** Every session read and write is scoped to `authorId` equal to the current user, matching every other endpoint on the existing workbench router. Cloud Agent runs join back to their session by project and session id so no developer can view or act on another developer's run.

---

## Non-Functional Requirements

- **Response time:** Start and Cancel complete at p95 under 2 seconds — persisting and enqueueing, or requesting cancellation, without waiting on the Cloud Agent implementation itself to finish.
- **Concurrency:** One live Cloud Agent run per My Work session, enforced at the database layer with a partial unique constraint; the row polls every 2–5 seconds while its current run is non-terminal and stops once the run reaches a terminal state.
- **Data volume:** Usage is Developer-group and self-only — tens of concurrent developers per project, not public scale. Each session keeps one current-run pointer; full run history stays on the existing run and run-event tables.

---

## Feature Flag

- **Flag required:** Yes
- **Flag name:** `my-work-cloud-agent`
- **Rollout sequence:** Internal → Beta → GA (Apex/internal first, then gradual project targeting)
- **Kill switch owner:** Apex platform team (via Platform Admin Feature Flags)
- **Behavior when disabled:** The My Work row keeps today's Start Development / Resume Session / Close actions (the existing local, in-process session flow). No Cloud Agent start, status, or cancel controls appear.

---

## Out of Scope

- Reconciler hosting for post-identity Cursor cancel confirmation, hard-timeout enforcement, and orphan-identity recovery — ownership is decided by a follow-on ADR.
- Verifying Azure Repos as a Cloud Agent launch target beyond accepting the `skillProvider` values Project Skill Settings already supports.
- Unit / e2e / WCAG test client implementation or hosting — checks execute inside the Cursor Cloud Agent run itself, not in Apex.
- Full ADO pull-request lifecycle in Apex: reviewers, votes, or a complete-PR action.
- Auto-created child bugs or new My Work rows for a run's remaining issues.
- GitHub Issues creation or two-way comment/state sync between GitHub and Azure DevOps.
- A new in-app chat panel or SSE stream showing Cloud Agent output on the row.
- A dedicated Cloud Agent detail page — status stays on the existing My Work row.

## Assumptions Made

- Reconciler hosting for post-identity Cursor cancel confirmation, hard-timeout enforcement, and orphan-identity recovery is decided by a follow-on ADR; until that reconciler is deployed, post-identity Cancel finalizes the Apex row without waiting for Cursor confirmation, and hard-timeout enforcement relies on the existing `timeoutAt` reaper check rather than an active Cursor cancel call.
- The Cursor Cloud Agent webhook callback mechanism supports HMAC-signed payloads; if Cursor does not support this, a follow-on ADR must name a fallback mechanism before event-driven completion can ship as designed.
- Azure Repos native work-item linking on a pull request is available through the same ADO write path Apex already uses to attach the PR URL relation or discussion to the work item.
- The project's existing development skill path and development model in Project Skill Settings are sufficient inputs for the Cloud Agent; no additional model or skill picker is introduced by this PRD.
- Unit, e2e, and WCAG checks are executed by the Cursor Cloud Agent itself as part of its implementation run; Apex only receives and displays the pass/fail summary and does not host or run these test clients.
- "ADO-configured" in this PRD means the project's work items live in Azure DevOps (not the app-native Apex/Amego PRD backlog); My Work rows for app-native projects are unaffected by this PRD.
- "Super Admin" in the original interview maps to the Platform Admin persona in Apex's RBAC model; Platform Admin's only elevated behavior in this flow is bypassing the ADO work-item type/origin eligibility check, not bypassing self-only ownership of Start/Resume/Cancel.
