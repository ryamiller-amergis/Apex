# Daily Standup Procedure (AI-Led Check-In & Scrum Master Readout)

This skill supports Apex's AI-led daily standup ceremony. Standups work seamlessly **with or without Azure DevOps**: plain-language check-ins, prior daily answers, open follow-ups, and team goals are first-class, while ADO / Git / pipeline evidence is additive when configured.

## Core Principles

1. **Personal Check-Ins Stay Personal (Strict Ownership Attribution)**:
   - Never attribute another teammate's assigned work item or authored pull request to the current participant.
   - `ChangedBy` or reviewer activity on someone else's item is at most an unselected suggestion — never preselected as personal work.
   - Cap personal suggestions to at most **3** items per section so the check-in takes under 60 seconds.
2. **Generic First (ADO Optional)**:
   - Not every team uses Azure DevOps or target dates. Plain-language updates (without `#ID` tickets) are complete and valid.
   - Propose 1–2 concise contextual questions based on what is going on: prior day's planned focus, unresolved blockers, open follow-ups, or the configured Team Goal.
3. **Scrum Master Readout**:
   - The facilitator synthesizes **confirmed participant check-ins** into a clean, read-aloud team readout: Team Goal, Blockers & Questions to Ask, and one short card per person (`Done`, `Today`, `Blockers/Notes`), clearly distinguishing `Submitted` vs `Waiting for check-in`.
   - Technical SDLC / pipeline signals (SQL migrations, skipped/failed Terraform plan stages, red QA builds) remain supplemental insights when code/pipeline evidence exists.

## Delivery Model Policy Rules

Adapt risk checks and questions to `deliveryModel` and `enableTargetDateChecks` from `# Session context`:

1. **`flow` (Flow / Kanban — Default)**:
   - Focus on flow aging, carryover streaks, and blockers. Do **not** ask for missing target dates unless `enableTargetDateChecks: true`.
2. **`sprint` (Sprint / Iteration)**:
   - Focus on current sprint goal progress, carryover streaks, and blockers. Do **not** require per-item target dates unless `enableTargetDateChecks: true`.
3. **`milestone` (Milestone / Release)**:
   - Check upcoming release milestones and flag release-relevant items missing a target date or at risk within 7 days.
4. **`support` (Support / Operations)**:
   - Focus on high-priority incidents, SLA age, and handoffs.
5. **`custom`**:
   - Apply only the thresholds enabled in `# Session context`.

## Optional ADO & Work Board Safety Rules

When a project uses Azure DevOps or the Apex Work Board:
- Filter ADO queries by `memberEmail` (`[System.AssignedTo] = '<memberEmail>'`) — never `@Me`.
- Format ADO work items as `#ID · Type — Title [State]` when work item IDs exist.
- **Never delete** work items, and **always confirm** before any write operation.

## Structured Check-In Output

```json
{
  "yesterday": "Completed partner onboarding checklist",
  "today": "Finalize Q4 rollout runbook",
  "blockers": "",
  "atRisk": "",
  "handoffs": "",
  "capacity": "",
  "userCorrections": ""
}
```

Leave any field that does not apply as `""`.
