---
name: Calendar Work-Item Assistant
status: implemented
---

# Calendar Work-Item Assistant

## Overview

A contextual AI assistant launched from the Calendar work-item details panel.
The user selects which work items the assistant may review, chats with an AI
to produce proposed Description and/or Acceptance Criteria changes, then
reviews an item-level diff and explicitly confirms before any change is
written to Azure DevOps.

## Architecture

```
DetailsPanel (launcher)
  → CalendarWorkItemAssistantPanel (scope step + chat)
       → POST /api/calendar-assistant/sessions
       → chatAgentService.createThread (assistantType: 'calendar-work-item')
       → SSE via /api/chat/threads/:id/stream
       → MCP: propose_work_item_changes (POST /mcp/calendar-assistant/:sessionId)
              → calendarWorkItemAssistantService.handleProposeWorkItemChanges
              → work_item_change_proposals (Postgres staging)
  → CalendarWorkItemChangesReview (per-item diff + confirmation)
       → POST /api/calendar-assistant/proposals/:id/apply
              → calendarWorkItemAssistantService.applyProposal
              → AzureDevOpsService.updateWorkItemContent (revision-guarded)
```

## Feature Flag

Key: `calendar-work-item-assistant`
Default: **disabled**
Rollout: enable selectively per project in Platform Admin → Feature Flags.

## Supported Editable Fields

| Work Item Type | Description | Acceptance Criteria |
|---|---|---|
| Epic | ✓ | ✓ |
| Feature | ✓ | ✓ |
| Product Backlog Item | ✓ | ✓ |
| Technical Backlog Item | ✓ | — |
| Bug, Task, etc. | — | — |

## Permissions

| Action | Required |
|---|---|
| Open assistant, view hierarchy | `calendar:view` + project assignment |
| Apply approved changes to ADO | `workitems:write` + project assignment + ADO user token |

## Safety Design

1. **Proposal-only MCP** — the calendar assistant's MCP server exposes only
   `propose_work_item_changes`. The general `update_work_item` tool is never
   available in calendar-work-item threads.

2. **Session-bound MCP URL** — the MCP endpoint at
   `/mcp/calendar-assistant/:sessionId` binds the MCP server to one session.
   The model cannot target another session or thread.

3. **Server-trusted `before` content** — the `before` field in every proposal
   is supplied by the server from the session snapshot, never from the model or
   browser.

4. **Revision guard** — each ADO write uses `If-Match: <expectedRev>`. If the
   item was edited concurrently, the write fails with a `STALE_REV` error and
   the item is reported as `stale` in the apply result.

5. **Mandatory UI diff review** — the agent cannot claim success; a pending
   proposal opens the `CalendarWorkItemChangesReview` panel. The user checks
   per-item checkboxes and clicks a second explicit confirmation before writes
   begin.

6. **Field allowlist** — only `System.Description` and
   `Microsoft.VSTS.Common.AcceptanceCriteria` are written; the generic
   `PATCH /api/workitems/:id/field` endpoint now requires `workitems:write`
   and rejects those two fields.

7. **Partial failure handling** — each item is applied independently. Stale
   and failed items are reported without blocking applied items.

8. **Idempotency** — if ADO already contains the generated HTML for a field,
   the item is marked `applied` without a second write.

9. **Content size limit** — each field is capped at 64 KB.

10. **Scope limit** — a session may include at most 50 work items.

## Data Model (Postgres)

### `work_item_assistant_sessions`
Owner-scoped row created per scope selection. Stores the immutable
`selectedWorkItemIds` and `contextSnapshot` (including baseline revisions).
Linked to one chat thread.

### `work_item_change_proposals`
Versioned, immutable change set staged by the agent. Lifecycle:
`pending` → `applying` → `applied` / `partially_applied` / `rejected` / `superseded`.
Prior pending proposals are superseded automatically when a new one is staged.

## Per-Project Configuration

Optional per-project settings in Admin → Project Settings:
- `calendar_assistant_skill_path` — custom SKILL.md path
- `calendar_assistant_model` — model override (falls back to project default)

## Rollout Checklist

1. Deploy migration `20260715170000_calendar-work-item-assistant.sql`.
2. Verify tables `work_item_assistant_sessions` and `work_item_change_proposals` exist.
3. In Platform Admin → Feature Flags, enable `calendar-work-item-assistant` for pilot projects.
4. Verify the Calendar DetailsPanel shows the "Assistant" button for users with `calendar:view`.
5. Test end-to-end: scope select → chat → `propose_work_item_changes` tool → review diff → apply → verify in ADO.
6. Monitor ADO write errors in server logs (`[calendar-assistant] proposals apply error`).
7. After stable rollout, retire the flag per the feature-flags skill cleanup workflow.
