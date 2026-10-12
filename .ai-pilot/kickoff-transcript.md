# ADR Decision Transcript: Reusable Playbook Interview Step

## Problem and scope

Apex's current core interview experience relies on `/grill-with-docs`. It is intentionally thorough and technically demanding, but Business Analysts report that the interview is too long and too technical. A BA can run an interview but cannot and should not modify the governing Skill.

The decision is whether Playbook orchestration should support a first-class `interview` node that can run either:

1. a human-led interview; or
2. a multi-agent-assisted interview whose internal Lead, Requirements, UX, and Technical agent orchestration remains owned by the interview service.

The Playbook must be reusable across Apex projects. A team must be able to install or instantiate the same Playbook without editing its graph to insert project-specific identifiers.

## Repository evidence

- `src/shared/types/playbook.ts` defines project-scoped Playbook definitions and immutable published versions. Runs pin the version they start with.
- `src/shared/types/playbook.ts` currently limits ordinary fan-out to one, caps agent steps at ten, and supports only `approval_gate` and `agent_run` suspension reasons.
- `src/server/services/playbookGuardService.ts` rejects graph loops and unsupported fan-out.
- `src/server/services/playbookSteps/registry.ts` is the sole declaration site for Playbook step types. `cursor-agent` currently allows only `app-knowledge` and `design-doc-validation` Skills and is classified as `leaves-apex`.
- `src/server/services/playbookSteps/approvalGateAdapter.ts` demonstrates the shared suspend/resume primitive for human waits.
- `src/server/services/playbookBindingResolver.ts` and `src/server/services/playbookStepBindings.ts` resolve `${input.<field>}` and `${steps.<stepId>.<field>}` placeholders from run input and prior step output.
- `src/shared/types/projectSettings.ts` already supports project-managed interview Skill options, models, reasoning effort, and downstream prototype/test-case choices.
- `src/client/components/InterviewChatView.tsx` already lets a user select an approved interview option and snapshots some downstream choices when an interview starts.
- `src/shared/types/interview.ts` models interviews as durable records linked to chat threads, but does not yet model a Playbook-owned interview step or an approved canonical interview brief.

## Fixed constraints

- A BA must not edit Skills.
- Only one coherent interviewer speaks to the BA at a time.
- Specialist agents must not hold an unbounded conversation with each other.
- Multi-agent reviews use bounded, structured outputs and at most one pass per specialist for each BA answer.
- The BA approves product intent through review checkpoints and a final brief.
- The approved brief is canonical for PRD generation; the transcript and specialist findings are supporting evidence.
- A Playbook run must survive process restarts and resume from durable Apex state.
- An in-progress run must stay pinned to its published Playbook version and its interview profile snapshot.
- The Playbook graph must remain stable whether multi-agent assistance is enabled or disabled.
- A reusable Playbook template must not embed project-specific Skill paths, model IDs, approver IDs, repository IDs, or profile row IDs.
- Project Admins configure approved interview profiles. BAs select an approved profile. Super Admins own the Skills.
- Phase 1 must preserve a migration path for existing interviews and `/grill-with-docs`.

## Decision drivers

1. Reduce interview abandonment and dissatisfaction caused by length and technical depth.
2. Preserve or improve PRD quality and traceability.
3. Keep one understandable BA-facing conversation.
4. Reuse Playbook durability, version pinning, status, permissions, and downstream composition.
5. Keep per-turn specialist orchestration out of a graph model that currently rejects loops and parallel fan-out.
6. Allow the same Playbook design to be instantiated in different projects.
7. Bound latency, model cost, retries, and failure behavior.
8. Preserve clear ownership between Platform Admin, Project Admin, BA, and technical reviewers.

## Considered options

### Option 1: Model every interviewer and specialist as Playbook nodes

The graph would contain Lead, Requirements, UX, and Technical agent steps, branches, and repeated rounds.

Benefits:
- Every agent action would be visible in the Playbook status model.
- The orchestration would be declarative.

Costs and risks:
- Current Playbook guards reject loops, joins, and ordinary fan-out above one.
- Interviews can exceed the ten-agent-step cap.
- Each `cursor-agent` step is a `leaves-apex` operation subject to current Skill allow-list and gate constraints.
- The graph would couple the reusable business process to the current specialist topology.
- Adding or removing a specialist would require publishing a different graph version.

Rejected because the current engine contract is a poor fit for a conversational loop and because it makes project portability and specialist evolution harder.

### Option 2: Keep interviews entirely outside Playbooks

The interview service would own the whole workflow, including start, checkpoints, final approval, and PRD handoff.

Benefits:
- Lowest initial integration effort.
- No new Playbook step type.
- Full freedom for conversational orchestration.

Costs and risks:
- Duplicates durable lifecycle, suspension, deadline, status, notification, and downstream composition concepts.
- An interview cannot be dropped into a larger project-specific Playbook.
- Management cannot compose interview, review, PRD, and later steps through one orchestration surface.

Rejected because it does not meet the requirement that interview be a reusable Playbook capability.

### Option 3: Add one first-class Playbook `interview` node with service-owned execution

The Playbook graph contains one `interview` node. The node can be configured for `human_led` or `multi_agent_assisted` mode. It suspends while the interview is active. The interview service owns the conversational loop and, when enabled, bounded Lead and specialist orchestration. It resumes the Playbook with an approved interview-brief reference.

Benefits:
- Keeps the graph linear and compatible with current Playbook structural limits.
- Reuses Playbook durability, version pinning, permissions, status, deadlines, and downstream steps.
- Keeps specialist topology private to the interview service, so specialists can evolve without graph changes.
- Supports human-led and assisted operation through one node contract.
- Allows a portable Playbook template to use stable profile keys and run-input bindings instead of project-specific IDs.

Costs and risks:
- Requires a new Playbook step type, suspend reason, adapter, completion/resume integration, schemas, permissions, reconciliation behavior, and UI.
- Requires durable interview orchestration and canonical brief records.
- Multi-agent execution adds latency and model cost.
- Reusable template installation/instantiation is not a verified existing Playbook feature and must be designed.

Selected.

## Selected decision

Add a first-class, suspending `interview` Playbook step. The step represents the entire interview lifecycle, not each conversational turn or specialist.

The step supports two modes:

- `human_led`: a human facilitator conducts the interview through the shared interview workspace and produces the reviewable brief.
- `multi_agent_assisted`: a Lead Interview Agent owns the BA-facing conversation. A Requirements Agent always reviews each answer; UX and Technical agents run only when deterministic routing finds their perspective relevant. Specialists return structured findings and never speak directly to the BA.

The Playbook node starts or attaches to a durable interview record, then suspends with an interview-specific reason and deadline. The interview service processes turns independently of the Playbook engine. When the BA approves the final brief, the service completes the interview step idempotently and resumes the pinned Playbook run with structured output.

The output contract includes stable references and summary state, such as `interviewId`, `briefId`, `briefVersion`, `approvedBy`, `approvedAt`, and unresolved-item counts. Large content remains in interview-owned storage rather than being copied into the Playbook step row.

## Cross-project portability decision

The reusable asset is a versioned Playbook template, not a shared project-scoped definition row.

Installing the template into a project creates a project-owned definition/draft that follows the existing project access boundary. The template graph contains no project-specific database IDs. It uses:

- stable semantic keys such as an interview profile key;
- Playbook run inputs and prior-step bindings;
- project settings resolved in the target project at run time; and
- installation-time validation that all required capabilities and profile keys exist.

The project-owned published version snapshots the template version and resolved compatibility metadata for auditability. Updating the reusable template never mutates an already published project version or an in-progress run.

The exact template packaging and installation schema belongs in the design document, but portability is a required contract of this decision.

## Phase 1 boundary

Phase 1 establishes the architectural seam:

1. Add the `interview` Playbook step and interview-specific suspension/resume behavior.
2. Support `human_led` mode using the shared interview workspace.
3. Support `multi_agent_assisted` mode with the Lead and Requirements agents only.
4. Produce and approve a canonical interview brief.
5. Resume the Playbook with the approved brief reference.
6. Define and validate a portable template contract using stable keys and run input rather than project IDs.
7. Preserve the current `/grill-with-docs` path for projects that have not adopted the new Playbook.

UX and Technical specialist activation, group-level defaults, richer management analytics, and a general template catalog may be delivered after the Phase 1 contract is proven. Their addition must not change the `interview` node's external contract.

## Positive consequences

- Interviews become composable Playbook capabilities.
- Teams can choose human-led or assisted execution without changing the graph.
- Specialist implementation can evolve independently from Playbook definitions.
- The BA sees one coherent conversation and explicit checkpoints.
- PRD generation receives an approved canonical brief.
- Project boundaries remain intact after a template is installed.
- Existing Playbook durability and version pinning cover long-running interviews.

## Negative consequences

- A new domain-specific Playbook adapter and suspend reason expand the engine contract.
- The interview service becomes a durable orchestrator rather than a thin chat wrapper.
- Multi-agent assistance increases token usage, latency, observability needs, and failure modes.
- Template installation and compatibility validation add a new lifecycle to manage.
- Human-led and assisted modes must produce the same output contract despite different execution paths.

## Failure, rollback, and operability

- If a specialist times out, the Lead continues with successful reviews when the profile permits and records the missing review.
- Duplicate completion callbacks must be idempotent.
- A deadline sweep expires abandoned interviews through the same Playbook reconciliation path used by other suspended steps.
- Cancelling the Playbook cancels or closes its owned interview without deleting the transcript or approved checkpoints.
- Disabling multi-agent assistance affects new interviews only; an in-progress interview follows its snapshotted mode and profile.
- Rollback disables creation of new `interview` nodes and routes projects back to the existing interview flow. Published historical versions and run records remain readable.
- Operations must expose the current phase, last activity, waiting party, deadline, specialist status, model usage, cost, and terminal reason without exposing hidden model reasoning.

## Security and ownership boundaries

- Project access and Playbook permissions apply before a run starts.
- Interview participation and review permissions are checked independently by the interview service.
- Specialist agents receive only the project and interview context required by their role.
- Persist structured findings, decisions, risks, and audit metadata; do not persist chain-of-thought.
- Project Admins manage available profiles and defaults.
- Super Admins manage the underlying Skills and reusable template publication.
- BAs select approved profiles, answer questions, edit the brief, and approve product intent.

## Unresolved risks

- The reusable template catalog/import mechanism is not verified as an existing capability and needs a dedicated design.
- The correct default deadline for an interview is not established by current behavior.
- The permission key for creating/configuring `interview` nodes needs RBAC design.
- Phase 1 must define whether a human facilitator can be reassigned while a node is suspended.
- The model and cost budget for multi-agent mode needs measured pilot data.
- The fallback behavior when a referenced profile key is missing or disabled at run start needs an explicit validation rule.

## References

- `context.md`
- `AGENTS.md`
- `.cursor/skills/grill-with-docs/SKILL.md`
- `.cursor/skills/grill-design/SKILL.md`
- `.cursor/skills/adr-interview/SKILL.md`
- `.cursor/skills/adr-finalize/SKILL.md`
- `design-docs/playbook-epic-1-phase-0.plan.md`
- `src/shared/types/playbook.ts`
- `src/shared/types/projectSettings.ts`
- `src/shared/types/interview.ts`
- `src/server/services/playbookGuardService.ts`
- `src/server/services/playbookBindingResolver.ts`
- `src/server/services/playbookStepBindings.ts`
- `src/server/services/playbookSteps/registry.ts`
- `src/server/services/playbookSteps/approvalGateAdapter.ts`
- `src/client/components/InterviewChatView.tsx`
# Kickoff Transcript — My Work Assigned Backlog and View Context

> Status: ready for `/to-prd`.
> Interview type: feature building (`/grill-with-docs`).
> Remaining grill questions were closed with the interviewer's recommended answers at the user's request.

---

## Feature Description

Add a personal **Assigned Backlog** section on **My Work** for Apex Backlog items (Feature Requests of type Feature, Issue, or Technical) assigned to the signed-in user in the current project — **not** Work Board items.

From that section the assignee can open **View Context** in **intake** mode, read the request details, and kick off (or resume) a design interview when allowed.

Assignment notifications for Apex Backlog items navigate to My Work and open that item.

On the same page, **Feature Backlog** (Approved PRD features) lists only features whose **Design Doc Owner** is the signed-in user.

This is full-stack (React My Work + Express listing/filter + notification link). No feature flag.

---

## Opening Questions (Q1–Q5)

### Q1 — Surface

- **Asked:** Frontend vs backend vs full-stack.
- **Answer:** Full-stack (client and server). Confirmed by user.

### Q2 — Access control

- **Asked:** Who can see the Assigned Backlog section; data scope.
- **Answer (user):** Keep My Work for **Developer**, **Platform Admin (Super Admin)**, and **Project Admin**. Items are **project-scoped and self-only** (assigned to that user in the current project).
- **Recommendation accepted for interview kickoff:** Start Interview still requires `interviews:manage` plus BA, Manager, or Product-Owner (same as today). Assignees who cannot start interviews can still view details.
- **RBAC:** Reuse `dev-workbench:view`. No new permission. Super Admin already bypasses group checks on the API; users with `admin:roles` (Project Admin) already bypass Developer group on `/api/dev-workbench`. Client nav currently also requires Developer group — **align nav and route fallback** so Super Admin and Project Admin can open `/my-work` without Developer membership (matches API).
- **Triage stays on Apex Backlog:** `feature-requests:manage` is not required to see one's own Assigned Backlog items.

### Q3 — Data sensitivity

- **Asked:** Credentials, tokens, PII.
- **Answer:** No. Same Feature Request payload already shown on Apex Backlog. No extra encrypt-at-rest, log masking, or API exclusion.

### Q4 — Non-functional requirements

- **Asked:** Performance bounds for loading My Work Assigned Backlog (and notification deep-link).
- **Answer:** Defaults accepted.
  - List API P95 ≤ 2 seconds.
  - Up to 100 concurrent users.
  - Up to 100 assigned items per user per project; no pagination below that.

### Q5 — Feature flag rollout

- **Asked:** Gate behind a flag?
- **Answer:** No flag — ship directly.

---

## Grilling Decisions

Closed with recommended answers (user: wrap remaining questions).

### Canonical item (user-confirmed)

An **Apex Backlog item** is a Feature Request of type **Feature**, **Issue**, or **Technical** assigned on Apex Backlog (`/feature-requests`). It is not a Work Board item and not a PRD Feature/PBI/TBI.

### Page layout

My Work section order for app-native projects:

1. **Assigned Backlog** — heading “Assigned Backlog”, subtitle “Apex Backlog items assigned to you”.
2. **Work Board** — existing assigned board items (unchanged, still not mixed into Assigned Backlog).
3. **Feature Backlog** — heading stays “Feature Backlog”, subtitle “Approved PRD features”; **filtered to Design Doc Owner**.

Empty Assigned Backlog still renders the section with copy: “No Apex Backlog items assigned to you.”

Card row shows: type badge (Feature / Issue / Technical), title, status, team priority if set, truncated request text. Primary action: **View Context**. Secondary: **Start Interview** or **Open Interview** when eligible.

### Which statuses appear

Default list: `new`, `under-review`, `in-interview`, `planned`.

Exclude `declined` and `done`. Exclude Apex-as-assignee (`assignedToApex`). Exclude items assigned to someone else.

### View Context — two modes, one shell

Reuse the existing View Context modal. Do not delete development tabs from the codebase. Drive visibility with a **view mode**:

| Mode | Opened from | Visible content | Hidden (not removed) |
|------|-------------|-----------------|----------------------|
| **intake** | Assigned Backlog (and assignment notification) | Request tab: type, title, status, request, advantage, submitter, linked ADRs, Start/Open Interview | PRD, Backlog (PRD hierarchy), Design Doc, Tech Spec, Assumptions, Prototype; Start Local Dev / Mark Complete / Clear Progress |
| **development** | Feature Backlog “View Context” | Existing tabs: PRD, Backlog, Design Doc, Tech Spec, Assumptions, Prototype | Intake request tab; Start Interview |

Chrome (title, type, close) stays. Intake mode should feel like reading a request, not a development briefing.

Do not send the user to `/feature-requests` to read their own assignment.

### Interview kickoff from My Work

Reuse the existing Feature Request interview prefill and kickoff path (same as the Apex Backlog detail drawer).

- **Feature** and **Technical** (`isInterviewableWorkItemType`): if no `interviewId` and user may start interviews → **Start Interview**. If `interviewId` exists → **Open Interview** (`/backlog/interview/{id}`).
- **Issue:** details only. No Start Interview. Helper text: “Issues are not interviewed from My Work.”
- After a successful start, status follows the existing Apex Backlog interview-link behavior (`in-interview` / `interviewId`).

Users who can see Assigned Backlog but cannot start interviews still get View Context; Start Interview is hidden.

### Assignment notification

Today the link is `/feature-requests?tab={type}&id={id}`. Change it to My Work:

`/my-work?section=backlog&itemId={id}`

On load, if the item is in the user's Assigned Backlog, scroll to Assigned Backlog and open View Context in **intake** mode. If the item is missing (unassigned, wrong project, declined/done, Apex-assigned), show a toast and leave My Work as-is — do not bounce to Apex Backlog.

Notification copy can stay “Work item assigned to you” / `{actor} assigned "{title}" to you`.

Self-assignment still does not notify (existing rule).

### Feature Backlog owner filter

`GET /api/dev-workbench/backlog-features` must return only features the signed-in user **owns as Design Doc Owner**.

Canonical owner field: the interview's **design-doc owner** (`designDocOwnerId` on the interview that produced the PRD). Super Admin and Project Admin get the **same self-only filter** on this list (they do not see every approved feature here).

If design-doc owner is unset, **exclude** the feature (do not show unowned work).

View Context in development mode, Start Local Dev, Mark Complete, and Clear Progress are unchanged for features that remain on the list.

### Assigned Backlog data

New (or extended) My Work API lists Feature Requests where:

- `sourceProject` = selected project
- `assignedToOid` = current user
- `assignedToApex` = false
- status in `new` | `under-review` | `in-interview` | `planned`

Requires `dev-workbench:view` (same router). Does not require `feature-requests:manage`.

---

## Unresolved Assumptions

- **Per-feature vs interview-level owner:** Design docs are per feature; owner lives on the **interview** (`designDocOwnerId`). Until a per-feature owner exists, every feature under that PRD shares the interview design-doc owner. Treat that as the product rule, not a gap to invent around.
- **Assigned Backlog on ADO-backed projects:** Ship Assigned Backlog on every project that has Apex Backlog menu/items, including projects that still use ADO work items below. If Apex Backlog is unused in that project, the section is empty.
- **Issue interviews:** Product already blocks Issue types from interview kickoff. This feature does not add a new interview skill for Issues.

---

## Key Design Decisions

1. Assigned Backlog is personal intake on My Work; Apex Backlog remains the team triage queue; Work Board remains execution assignments.
2. View Context is mode-driven (`intake` vs `development`); development tabs stay in code and hide in intake mode.
3. Notification deep-link is My Work, not Apex Backlog.
4. Feature Backlog is Design Doc Owner only, enforced on the server.
5. No feature flag. NFRs: P95 ≤ 2s, 100 concurrent users, ≤ 100 assigned items, no pagination in v1.
6. Interview start authorization is unchanged (BA / Manager / Product-Owner + `interviews:manage`).
7. Client My Work visibility must match API: Developer **or** Super Admin **or** Project Admin (`admin:roles`).
)
