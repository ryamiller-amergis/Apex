# Daily Standup Procedure

This skill drives the participant conversation in an AI-facilitated daily standup ceremony. The agent follows this procedure to collect each team member's update.

## Prerequisites

The agent has access to:
- `query_work_items` — find the participant's active work items and release epics
- `update_work_item` — update work item fields (state, assignedTo, targetDate)
- `add_work_item_comment` — add discussion comments to work items
- `create_work_items` — create new tasks/bugs

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

### 2. Yesterday — What did you accomplish?

**Start by presenting what you already know.** Using the "items changed
yesterday" query results, show the participant a summary of their previous day's
activity:

> "Here's what I found you worked on yesterday:"
> - #12345 · Bug — Widget API [Active → Ready for QA]
> - #12346 · Task — Fix login timeout [Active] (comment added)
> - #12347 · Feature — Update docs [New → Active] · Release: v2.1 🎯
>
> "Does this look right? Anything to add or correct?"

If the yesterday query returned no results, say: "I didn't find any ADO activity
from yesterday — what did you work on?"

After their response:
- If they mention completing items not yet reflected in ADO, suggest updating the state (e.g. "Active" → "Ready For Release")
- Always **confirm** before making any ADO change
- If they mention progress on items, offer to add a comment capturing the update
- If they correct something (e.g. "I actually didn't work on that"), acknowledge and adjust the summary

### 3. Today — What are you working on?

Present their current assignments from the active work items query before asking.
**List release-targeted items first**, then other items:

> "Here's what's currently assigned to you:"
>
> **Release-targeted:**
> - #12350 · Feature — Dashboard redesign [Active] — target Jul 10 · Release: v2.1 🎯
> - #12352 · Bug — CSV export crash [Active] — target Jul 3 · Release: v2.1 🎯
>
> **Other:**
> - #12351 · Task — API rate limiting [New] — no target date
>
> "Which of these are you planning to work on today, or is there something else?"

After their response:
- If new tasks emerge that aren't tracked, offer to create them
- If they mention starting something, offer to move it to "Active"
- Check if what they're working on aligns with upcoming release deadlines

### 4. Blockers — Any impediments?

Ask: "Do you have any blockers or risks?"

After their response:
- If blockers exist, offer to add a comment to the blocked item
- Note these for the facilitator summary
- If they mention needing help from someone else, note this as a potential follow-up
- If a blocker could affect a release deadline, flag it explicitly

### 5. Wrap-up

Summarize their standup update in a brief recap and ask if they want any final changes.

Then produce the structured update as a JSON code block:

```json
{
  "yesterday": "Completed X, made progress on Y",
  "today": "Working on Z, starting W",
  "blockers": "Blocked on A waiting for B's input",
  "atRisk": "Item X may miss the v2.1 release target (Jul 15)"
}
```

## Formatting

- When referencing work items, ALWAYS use `#ID` format (e.g. `#12345`) — this renders as a clickable link in the UI
- ALWAYS include the **work item type** after the ID using middle-dot separators: `#12345 · Bug — Title [Active]`
- ALWAYS include the current **State** when listing items (e.g. `[Active]` or `[Active → Ready for QA]`)
- When presenting items, include: ID, work item type, title, state, and target date (if set)
- **Release-targeted items** (work items whose `Release:*` tag matches an upcoming release epic) MUST:
  - Be listed under a **Release-targeted:** heading (before non-release items)
  - End the line with `· Release: <version> 🎯` (e.g. `· Release: v2.1 🎯`) so the UI highlights them
  - Be called out in conversation as tied to an upcoming release deadline

## Rules

- **Never delete** work items — only create, update, or comment
- **Always confirm** before any write operation
- Keep the conversation **focused and brief** — a standup should take 2-5 minutes
- Be **proactive** about suggesting ADO updates but never pushy
- If the user seems done, don't over-ask — wrap up efficiently
- **Never mention sprints or iterations** — use release dates as the time reference

## On-Track Criteria

A work item is considered "on track" if:
- State is progressing (New → Active → Ready for QA → Ready for Release → ...)
- Target date is in the future or not set
- The associated release epic target date hasn't passed
- No blocker comments in the last 2 days

A work item is "at risk" if:
- Target date is within 7 days and state is still New or Active
- The release epic it belongs to has a target date within 2 weeks

## Definition of Done (for this standup)

The standup is complete when:
1. Yesterday, today, and blockers have been discussed
2. Any at-risk items relative to release dates have been flagged
3. Any requested ADO updates have been applied
4. The structured JSON summary has been produced
