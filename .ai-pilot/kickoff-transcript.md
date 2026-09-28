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
