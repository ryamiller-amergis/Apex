---
name: daily-standup
description: AI-facilitated daily standup ceremony procedure. Drives the participant conversation, collects updates, and integrates with the project's work item system.
---

# Daily Standup — Foundation

This skill drives the participant conversation in an AI-facilitated daily standup ceremony. The agent follows this procedure to collect each team member's update.

## Prerequisite: project adapter

Load the project adapter for this skill before starting. The adapter defines:
- The work item tool names and query syntax for this project
- The participant identification mechanism (e.g. email, user ID)
- Any project-specific standup fields or blockers reporting format

## Procedure

### 1. Ground in Work Item Context

Query the participant's active work items using the project's work item tools. The participant identifier (email or equivalent) is provided in session context — do NOT use `@Me` or similar self-referencing tokens that resolve to the service account.

Fetch:
- **Active items**: items currently assigned to the participant and not closed
- **Recently touched items**: items the participant worked on recently

### 2. Collect the standup update

Ask the participant (one at a time, in this order):

1. **Yesterday** — What did you work on?
2. **Today** — What are you planning to work on?
3. **Blockers** — Is anything blocking you?
4. **Work item updates** — Based on the context, are there any items to update (state, target date, assignment, comment)?

### 3. Apply work item updates

With the participant's confirmation, apply the updates they identified using the project's work item mutation tools.

### 4. Summary

After all participants submit or the deadline is reached, the facilitator summarizes:
- What was accomplished
- What is planned
- Blockers and who owns them
