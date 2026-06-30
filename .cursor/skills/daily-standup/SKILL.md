# Daily Standup Procedure

This skill drives the participant conversation in an AI-facilitated daily standup ceremony. The agent follows this procedure to collect each team member's update.

## Prerequisites

The agent has access to:
- `query_work_items` — find the participant's active work items and release epics
- `update_work_item` — update work item fields (state, assignedTo, targetDate, tags, parent)
- `add_work_item_comment` — add discussion comments to work items (use to @-mention people)
- `create_work_items` — create new tasks/bugs/PBIs

## Procedure

### 1. Ground in Work Item Context

Query the participant's active work items **and** items they touched yesterday.
Filter by the participant's email (ADO uniqueName), which is provided in the
session context as `memberEmail` — do NOT use `@Me`, since that resolves to the
service account rather than the member.

**Do NOT filter by iteration/sprint** — the team uses release target dates, not sprints.

**Active work items (current backlog):**
```
WIQL: SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State],
             [System.AssignedTo], [Microsoft.VSTS.Scheduling.TargetDate], [System.Tags]
FROM WorkItems
WHERE [System.AssignedTo] = '<memberEmail>'
AND [System.State] <> 'Closed'
AND [System.State] <> 'Done'
AND [System.State] <> 'Removed'
ORDER BY [Microsoft.VSTS.Scheduling.TargetDate] ASC, [Microsoft.VSTS.Common.Priority]
```

**Items changed yesterday** (state changes, comments, updates — includes items
that may now be Closed/Done):
```
WIQL: SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State],
             [System.ChangedDate], [System.AssignedTo],
             [Microsoft.VSTS.Scheduling.TargetDate], [System.Tags]
FROM WorkItems
WHERE [System.ChangedBy] = '<memberEmail>'
AND [System.ChangedDate] >= @Today - 1
AND [System.ChangedDate] < @Today
ORDER BY [System.ChangedDate] DESC
```

**Upcoming release epics:**
```
WIQL: SELECT [System.Id], [System.Title], [Microsoft.VSTS.Scheduling.TargetDate], [System.State]
FROM WorkItems
WHERE [System.WorkItemType] = 'Epic'
AND [System.Tags] CONTAINS 'ReleaseVersion'
AND [System.State] <> 'Closed'
AND [System.State] <> 'Done'
ORDER BY [Microsoft.VSTS.Scheduling.TargetDate] ASC
```

**Cross-reference releases with work items:** After querying both, check each
work item's `[System.Tags]` for `Release:*` tags (e.g. `Release:v2.1`). If a
tag matches any upcoming release epic's version, that item is **release-targeted**
and must be highlighted in the output (see Formatting below).

### 2. Yesterday — What did you accomplish? (verify, don't just list)

**Start by presenting what you already know**, then actively **verify the status is correct**.
A large part of this team's standup is catching work items whose ADO state no
longer reflects reality. Don't passively read the list back — interrogate it.

Using the "items changed yesterday" query results, show the participant a summary:

> "Here's what I found you worked on yesterday:"
> - #12345 · Bug — Widget API [In PR]
> - #12346 · Task — Fix login timeout [Active] (comment added)
> - #12347 · Feature — Update docs [New → Active] · Release: v2.1 🎯
>
> "Does this look right? Anything to add or correct?"

If the yesterday query returned no results, say: "I didn't find any ADO activity
from yesterday — what did you work on?"

**Status-accuracy checks (do these proactively):**
- **Stale state:** If an item has been sitting in an interim state (e.g. `In PR`,
  `Active`, `Ready for Test`) since yesterday or earlier, ask: *"#12345 has been in
  `In PR` since yesterday — is that still the right status, or should it have moved
  to `merged to test` / `Ready for Test`?"*
- **Pipeline-driven transitions:** This team has automated pipelines that flip an
  item's state when builds/tests pass. If a member says work is "merged" or "done"
  but the state hasn't advanced, ask whether the pipeline ran, and offer to set the
  state manually if it didn't flip.
- **PR vs. work-item mismatch:** If a PR is merged but the work item is still `Active`/`In PR`,
  flag it and offer to advance the state.

After their response:
- If they completed items not yet reflected in ADO, suggest updating the state using
  this team's real states (see **State Vocabulary** below).
- Always **confirm** before making any ADO change.
- If they mention progress, offer to add a comment capturing the update.
- If they correct something ("I actually didn't work on that"), acknowledge and adjust.

### 3. Today — What are you working on?

Present their current assignments from the active work items query before asking.
**List release-targeted items first**, then other items. **Flag missing metadata** as
you go — the facilitator routinely calls out tickets with no target date.

> "Here's what's currently assigned to you:"
>
> **Release-targeted:**
> - #12350 · Feature — Dashboard redesign [Active] — target Jul 10 · Release: v2.1 🎯
> - #12352 · Bug — CSV export crash [Active] — ⚠️ no target date · Release: v2.1 🎯
>
> **Other:**
> - #12351 · Task — API rate limiting [New] — no target date
>
> "Which of these are you working on today, or is there something else?"

After their response:
- **Missing target dates:** If a release-relevant item has no target date, treat it as
  an actionable gap: *"#12352 is tied to v2.1 but has no target date — want me to set one?"*
- If new tasks emerge that aren't tracked, offer to create them.
- If they mention starting something, offer to move it to `Active`.
- **Handoffs:** If work is moving to someone else ("I'm sending this back to the dev",
  "reassigning to QA"), capture **who it goes to next** and offer to update `assignedTo`.
- **Capacity / availability:** If the member has no work, is waiting on an external
  dependency (e.g. design/Figma access, another team), or is available to pick up work,
  capture that explicitly — it helps the facilitator reassign. Also capture PTO /
  partial-day / "off Friday" notes.

### 4. Blockers & Risks — Any impediments?

Ask: "Do you have any blockers or risks?" Distinguish these blocker types, since they
route to different follow-ups:

- **Pipeline / build failures:** e.g. "the dev pipeline is failing, the server may be
  down." Capture which pipeline and the suspected cause. These are first-class blockers,
  not just "stuck."
- **Waiting on a person:** needs review, help, or a handoff from a specific teammate.
- **Waiting on an external dependency:** design assets, access, another team, environment.
- **Production support / incidents:** unplanned prod issues. Per team direction, **production
  support is top priority around a release.** Capture the item, and note the expectation to
  **explain the root cause in the dev chat** (why the issue occurred). Offer to create a
  bug/PBI if one doesn't exist.

After their response:
- If blockers exist, offer to add a comment to the blocked item.
- Note these for the facilitator summary; if a blocker could affect a release deadline,
  flag it explicitly.
- If they need help from someone else, note this as a potential cross-cutting follow-up.

### 5. Tagging & QA Notification Conventions

This team relies on tags and @-mentions to keep QA in the loop. Offer these where relevant:

- **Deferred / non-blocking bugs:** If a bug won't be fixed for the upcoming release and is
  **not a blocker**, offer to add the team's deferral tag (e.g. `deferred` / `default`) so the
  parent PBI can be signed off. **Whenever you tag or change a bug's disposition, @-mention QA
  in a comment** so they aren't left assuming it's still being fixed.
- **Missing requirement:** If a bug is really a missed requirement, it may need to be
  converted to / re-parented under a PBI. Offer to create the PBI and update the parent link.
- **Parent/child links:** When a bug is split off or re-scoped, offer to update its parent so
  the original PBI can keep moving.

Always **confirm** before tagging, re-parenting, or reassigning.

### 6. Wrap-up

Summarize their standup update in a brief recap and ask if they want any final changes.

Then produce the structured update as a JSON code block:

```json
{
  "yesterday": "Completed X, made progress on Y",
  "today": "Working on Z, starting W",
  "blockers": "Dev pipeline failing (server down); waiting on Figma access",
  "atRisk": "Item #123 may miss the v2.1 release target (Jul 15) — still In PR, no target date",
  "handoffs": "#456 reassigned to QA (Pragna) for retest",
  "capacity": "Available to pick up bugs; off Friday"
}
```

`blockers`, `atRisk`, `handoffs`, and `capacity` feed the facilitator's cross-cutting
analysis. Leave a field as an empty string if it doesn't apply.

## Formatting

- When referencing work items, ALWAYS use `#ID` format (e.g. `#12345`) — this renders as a clickable link in the UI
- ALWAYS include the **work item type** after the ID using middle-dot separators: `#12345 · Bug — Title [Active]`
- ALWAYS include the current **State** when listing items (e.g. `[Active]` or `[In PR → Ready for Test]`)
- When presenting items, include: ID, work item type, title, state, and target date (if set)
- Mark a release-relevant item with **no target date** using `⚠️ no target date`
- **Release-targeted items** (work items whose `Release:*` tag matches an upcoming release epic) MUST:
  - Be listed under a **Release-targeted:** heading (before non-release items)
  - End the line with `· Release: <version> 🎯` (e.g. `· Release: v2.1 🎯`) so the UI highlights them
  - Be called out in conversation as tied to an upcoming release deadline

## State Vocabulary

Use this team's actual states when suggesting transitions (do NOT invent "Ready for QA"):

`New → Active → In PR → merged to test → Ready for Test → UIT → UAT → Ready for Release → Closed`

- Bugs that fail testing are sent **back to the developer** (state regresses to `Active`).
- `committed` is used for items accepted but not yet started/scheduled.
- Confirm the exact state name from the work item if unsure — match what already exists in ADO.

## Rules

- **Never delete** work items — only create, update, comment, tag, or re-parent
- **Always confirm** before any write operation (state, assignee, target date, tag, parent)
- Keep the conversation **focused and brief** — a standup should take 2-5 minutes
- Be **proactive** about suggesting ADO updates (state accuracy, target dates, tags, handoffs) but never pushy
- If the user seems done, don't over-ask — wrap up efficiently
- **Never mention sprints or iterations** — use release dates as the time reference

## On-Track Criteria

A work item is considered "on track" if:
- State is progressing along the vocabulary above (New → Active → In PR → ... → Ready for Release)
- Target date is in the future or not set
- The associated release epic target date hasn't passed
- No blocker comments in the last 2 days

A work item is "at risk" if:
- It is release-targeted and has **no target date**
- Target date is within 7 days and state is still `New`, `Active`, or `In PR`
- It has been sitting in the same interim state since before yesterday (stale)
- The release epic it belongs to has a target date within 2 weeks
- It is blocked by a failing pipeline or an unresolved production incident

## Definition of Done (for this standup)

The standup is complete when:
1. Yesterday (with status-accuracy verification), today, and blockers have been discussed
2. Any at-risk items relative to release dates — including missing target dates and stale states — have been flagged
3. Any requested ADO updates (state, assignee, target date, tags, parent) have been applied
4. The structured JSON summary has been produced
