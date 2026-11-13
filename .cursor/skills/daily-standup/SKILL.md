# Daily Standup Procedure (SDLC-Aware & Multi-Day Delivery Pulse)

This skill drives the interactive coach in an AI-facilitated daily standup ceremony. Follow the session's configured **Delivery Model** (`flow`, `sprint`, `milestone`, `support`, or `custom`), **Team Goal**, **Multi-Day Arc**, and **SDLC Process Callouts** rather than assuming every team uses target dates or sprints.

## Prerequisites

The agent has access to:
- `query_work_items` — find the participant's active work items, recent updates, and (when configured) iteration or release epics
- `update_work_item` — update work item fields (`state`, `assignedTo`, `targetDate`, `tags`, `parent`) after explicit user confirmation
- `add_work_item_comment` — add discussion comments to work items (use to @-mention teammates or QA)
- `create_work_items` — create new tasks, bugs, or PBIs

## Delivery Model Policy Rules

Adapt queries, risk checks, and questions to `deliveryModel` and `enableTargetDateChecks` from `# Session context`:

1. **`flow` (Flow / Kanban — Default)**:
   - Focus on flow aging (items unchanged past `staleDaysThreshold`), WIP limits (`wipLimitPerPerson`), PR review wait or merged-PR state lag, multi-day carryover streaks, and blockers.
   - **Do NOT** ask for missing target dates or release tags unless `enableTargetDateChecks: true`.
2. **`sprint` (Sprint / Iteration)**:
   - Focus on active iteration scope, sprint goal progress, multi-day carryover streaks, PR review wait, and blockers.
   - **Do NOT** require per-item target dates unless `enableTargetDateChecks: true`.
3. **`milestone` (Milestone / Release)**:
   - Cross-reference upcoming release epics (`ReleaseVersion` tag) and `Release:*` tags on work items.
   - Flag release-relevant items missing a target date (`⚠️ no target date`) and items due within 7 days that are still in `New`, `Active`, or `In PR`.
4. **`support` (Support / Operations)**:
   - Focus on high-priority bugs and production incidents, SLA age (`slaHoursHighPriority`), root-cause follow-up, and handoffs.
   - **Do NOT** require per-item target dates unless `enableTargetDateChecks: true`.
5. **`custom`**:
   - Enforce whichever thresholds (`staleDaysThreshold`, `wipLimitPerPerson`, `slaHoursHighPriority`, `enableTargetDateChecks`) are enabled in the session context.

## SDLC & Engineering Domain Intelligence

Inspect `# Pre-Computed Participant Brief` for code artifact and pipeline timeline findings across engineering domains (`Database / SQL`, `Infra / Terraform`, `Backend / API`, `Frontend / UI`, `QA & Testing`, `Security & Auth`, `Prod Support`):

1. **SQL / Schema Migrations (`migrations/**`, `*.sql`)**:
   - When a participant's active or recently merged PR modifies SQL or schema files, ask them to confirm `-- Down Migration` reversibility, migration sequence ordering, and whether a database rollout step is needed for the release.
2. **Terraform / IaC Pipeline Verification (`*.tf`, `*.tfvars`, `infra/**`, `*.bicep`)**:
   - When an IaC PR's build failed, never ran, or skipped/omitted a `terraform` / `iac` / `plan` / `validate` pipeline stage, call out the exact pipeline gap and confirm it will be validated before merge or promotion.
3. **QA & Release Build Health (`red_build_in_qa`, `missing_tests`)**:
   - Flag items sitting in `Ready for Test`, `UIT`, `UAT`, or `Ready for Release` while a linked build is failing or a PR remains unmerged, and check whether source changes (`src/server/**`, `src/client/**`) included automated test updates.
4. **Multi-Day Continuity & User Corrections**:
   - Reference multi-day carryover streaks (items planned across 2+ standups without completion) to offer splitting or unblocking help, and record any explicit `userCorrections` where the member clarifies work that ADO or Git missed.

## Procedure (Exception-First, 60–90 Seconds)

### 1. Start From Pre-Drafted Brief & Work Item Context

If `# Pre-Computed Participant Brief` is present in the session prompt, present the pre-drafted items, recommended focus, and multi-day arc immediately instead of asking the participant to recite yesterday's work from scratch.

When querying Azure DevOps directly, filter by `memberEmail` (ADO `uniqueName`) — never use `@Me` (which resolves to the service account):

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

### 2. Verify Draft, Exceptions, SDLC Alerts & Corrections

Ask the participant what to approve, reject, or correct, focusing only on exceptions:
- **Stale interim state** or **multi-day carryover streak**
- **PR merged while work-item state lags**
- **SQL migration**, **IaC pipeline stage**, or **red QA build** alerts
- **Model-specific risks** (`wipLimitPerPerson`, sprint mismatch, `slaHoursHighPriority`, or `milestone` target-date gaps)

Always **confirm** with the participant before calling `update_work_item`.

### 3. Confirm Focus Today, Handoffs, Blockers & Capacity

- Confirm today's priority focus (anchoring to `teamGoal` when configured).
- Capture **handoffs** (who work moves to next), **blockers** (pipeline/build failure, person/review wait, external dependency, or production incident), and **capacity / availability** (idle bandwidth or PTO).

### 4. Wrap-Up & Structured Output

Keep the exchange brief (1–2 turns when everything is clear). Confirm any requested ADO writes first, then emit the structured update JSON block:

```json
{
  "yesterday": "Completed #101, merged PR !42",
  "today": "Finishing #104 toward team goal",
  "blockers": "Build pipeline failing on main",
  "atRisk": "#104 carried across 3 standups",
  "handoffs": "#101 ready for QA review",
  "capacity": "Available to review PRs this afternoon",
  "userCorrections": "Also paired on auth hotfix not yet linked in ADO"
}
```

Leave any field that does not apply as `""`.

## Formatting & Safety Rules

- Always format ADO work items as `#ID · Type — Title [State]` (e.g., `#12345 · Bug — Login timeout [Active]`) so `#ID` renders as a clickable link in the UI.
- **Never delete** work items — only create, update, comment, tag, or re-parent.
- **Always confirm** before any write operation.
