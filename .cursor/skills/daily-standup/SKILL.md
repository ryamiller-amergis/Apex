# Daily Standup Procedure (Delivery Pulse)

This skill drives the interactive coach in an AI-facilitated daily standup ceremony. Follow the session's configured **Delivery Model** (`flow`, `sprint`, `milestone`, `support`, or `custom`), **Team Goal**, and **Delivery Policy** rather than assuming every team uses target dates or sprints.

## Prerequisites

The agent has access to:
- `query_work_items` — find the participant's active work items, recent updates, and (when configured) iteration or release epics
- `update_work_item` — update work item fields (`state`, `assignedTo`, `targetDate`, `tags`, `parent`) after explicit user confirmation
- `add_work_item_comment` — add discussion comments to work items (use to @-mention teammates or QA)
- `create_work_items` — create new tasks, bugs, or PBIs

## Delivery Model Policy Rules

Adapt queries, risk checks, and questions to `deliveryModel` and `enableTargetDateChecks` from `# Session context`:

1. **`flow` (Flow / Kanban — Default)**:
   - Focus on flow aging (items unchanged past `staleDaysThreshold`), WIP limits (`wipLimitPerPerson`), PR review wait or merged-PR state lag, untouched commitments from last standup, and blockers.
   - **Do NOT** ask for missing target dates or release tags unless `enableTargetDateChecks: true`.
2. **`sprint` (Sprint / Iteration)**:
   - Focus on active iteration scope, sprint goal progress, commitment carryover, PR review wait, and blockers.
   - **Do NOT** require per-item target dates unless `enableTargetDateChecks: true`.
3. **`milestone` (Milestone / Release)**:
   - Cross-reference upcoming release epics (`ReleaseVersion` tag) and `Release:*` tags on work items.
   - Flag release-relevant items missing a target date (`⚠️ no target date`) and items due within 7 days that are still in `New`, `Active`, or `In PR`.
4. **`support` (Support / Operations)**:
   - Focus on high-priority bugs and production incidents, SLA age (`slaHoursHighPriority`), root-cause follow-up, and handoffs.
   - **Do NOT** require per-item target dates unless `enableTargetDateChecks: true`.
5. **`custom`**:
   - Enforce whichever thresholds (`staleDaysThreshold`, `wipLimitPerPerson`, `slaHoursHighPriority`, `enableTargetDateChecks`) are enabled in the session context.

## Procedure (Exception-First, 60–90 Seconds)

### 1. Ground in Pre-Computed Brief & Work Item Context

If `# Pre-Computed Participant Brief` is present in the session prompt, start from it immediately instead of asking the participant to recite yesterday's work from scratch.

When querying Azure DevOps, filter by `memberEmail` (ADO `uniqueName`) — never use `@Me` (which resolves to the service account):

```sql
SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State],
       [System.AssignedTo], [Microsoft.VSTS.Scheduling.TargetDate],
       [System.IterationPath], [System.Tags]
FROM WorkItems
WHERE [System.AssignedTo] = '<memberEmail>'
  AND [System.State] <> 'Closed'
  AND [System.State] <> 'Done'
  AND [System.State] <> 'Removed'
ORDER BY [System.ChangedDate] DESC
```

### 2. Verify Since Last Standup & Exceptions

Present pre-detected accomplishments and ask **only** about detected exceptions:
- **Stale interim state**: Item sitting in `Active`, `In PR`, or `Ready for Test` longer than `staleDaysThreshold`.
- **PR vs. work-item mismatch**: Merged PR while the linked work item is still `New`, `Active`, or `In PR`.
- **Untouched commitment**: An item planned in the prior standup's `today` list with no recorded ADO or PR progress.
- **Model-specific risks**:
  - `flow`: Active items exceeding `wipLimitPerPerson`.
  - `sprint`: Active work outside the current iteration or threatening the sprint goal.
  - `milestone` (or `enableTargetDateChecks: true`): Missing target dates on release items or near-due items in early states.
  - `support`: High-priority bugs/incidents exceeding `slaHoursHighPriority`.

Always **confirm** with the participant before calling `update_work_item`.

### 3. Confirm Focus Today, Handoffs & Capacity

- Confirm which items they are focusing on today (anchoring to `teamGoal` when configured).
- Capture **handoffs** (who work moves to next, offering `assignedTo` updates after confirmation).
- Capture **capacity / availability** (idle bandwidth to help teammates, waiting on external dependencies, or upcoming PTO / partial days).

### 4. Blockers & Impediments

Distinguish blocker categories clearly so the Team Pulse huddle can act on them first:
- **Pipeline / build failures** (which pipeline/branch failed)
- **Waiting on a person / review** (specific teammate or PR)
- **External dependency** (design assets, environment, access, vendor)
- **Production incident** (capture owner and root-cause follow-up)

### 5. Wrap-Up & Structured Output

Keep the exchange brief (1–2 turns when everything is clear). Confirm any requested ADO writes first, then emit the structured update JSON block:

```json
{
  "yesterday": "Completed #101, merged PR !42",
  "today": "Finishing #104 toward team goal",
  "blockers": "Build pipeline failing on main",
  "atRisk": "#104 unchanged in Active for 4 days",
  "handoffs": "#101 ready for QA review",
  "capacity": "Available to review PRs this afternoon"
}
```

Leave any field that does not apply as `""`.

## Formatting & Safety Rules

- Always format ADO work items as `#ID · Type — Title [State]` (e.g., `#12345 · Bug — Login timeout [Active]`) so `#ID` renders as a clickable link in the UI.
- **Never delete** work items — only create, update, comment, tag, or re-parent.
- **Always confirm** before any write operation.
