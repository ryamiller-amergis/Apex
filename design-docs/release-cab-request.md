---
name: Release CAB Request
overview: Add a flagged Create CAB action on Planning → Releases that confirms dry-run vs run and optional branch cut, then streams the MaxView cab-release skill on the same page. No new Express routes or DB tables.
todos:
  - id: phase-1a-confirm-modal
    content: "Phase 1a: CreateCabRequestModal + tests (dry-run/run, cut-branch, confirm)"
    status: done
  - id: phase-1b-kickoff-text
    content: "Phase 1b: cabReleaseKickoff pure builder + unit tests"
    status: done
  - id: phase-1c-flag-entry
    content: "Phase 1c: ReleaseCabRequestAction with release-cab-request top-level flag split"
    status: done
  - id: phase-2a-assistant-panel
    content: "Phase 2a: CabReleaseAssistantPanel — thread + useAgentChatSession stream"
    status: done
  - id: phase-2b-release-view
    content: "Phase 2b: Wire Actions menu in ReleaseView to modal then panel"
    status: done
isProject: false
---

# Release CAB Request

ADO [55352](https://dev.azure.com/amergis/MaxView/_workitems/edit/55352/) — Phase 3 ServiceNow CAB ticket.

## Current State

`ReleaseView.tsx` Actions include Edit, Link Items, Deployment Outcome, a stub Create Changelog, and Delete. There is no Create CAB request control.

Release related work item IDs already load via `GET /api/releases/:epicId/related-items`.

The MaxView `cab-release` skill drafts the ServiceNow CAB body, updates the Manual Release wiki, queues `mv-application-qa-snow.yml` or `mv-application-prod-snow.yml`, and optionally cuts `Release/{version}` from `development` only after snow succeeds. That skill explicitly leaves the Apex Actions button to this repo.

`ChatAgentPanel` only opens on Agent Home. Other in-page assistants (calendar, PRD) use `AgentPanelShell` plus `useAgentChatSession`.

## Architecture

```mermaid
flowchart TD
  actions[ReleaseView Actions]
  flag[useFeatureFlag release-cab-request]
  modal[CreateCabRequestModal]
  panel[CabReleaseAssistantPanel]
  start[POST /api/chat/threads]
  msg[POST /api/chat/threads/id/messages]
  stream[GET /api/chat/threads/id/stream]
  skills[project_skill_settings]
  agent[cab-release skill in MaxView]
  snow[qa-snow or prod-snow]

  actions --> flag
  flag -->|on| modal
  modal -->|confirm| panel
  panel --> start
  start --> skills
  panel --> msg
  panel --> stream
  msg --> agent
  agent --> snow
```

No new tables. No new routes.

## Database Schema

None.

## Server Changes

None. Reuse existing chat thread APIs and `GET /api/releases/:epicId/related-items`.

## Client Changes

### Utility: `src/client/utils/cabReleaseKickoff.ts`

Builds the first user message from target version, epic id, related ids, previous branch, snow mode, and cut-branch.

Skill path constant: `.cursor/skills/cab-release/SKILL.md`.

### Component: `src/client/components/CreateCabRequestModal.tsx`

react-hook-form + zod. Confirm before any thread is created.

### Component: `src/client/components/ReleaseCabRequestAction.tsx`

Feature entry. Flag `release-cab-request` top-level split. Also requires `planning:releases` and `chat:create`. The action does not check the BA group or wait for `cab-release` to appear in the project skill list.

### Component: `src/client/components/CabReleaseAssistantPanel.tsx`

`AgentPanelShell` + `AgentComposer` + `useAgentChatSession`. `useStartChat` with `skipAutoKickoff: true` and project skill config from `useProjectSkillConfig`.

### `ReleaseView.tsx`

Actions item opens the modal; confirm opens the panel.

## Key Design Decisions

1. Reuse interactive chat instead of Apex calling ADO pipelines — the skill owns snow, wiki, and git.
2. Pre-answer dry-run/run and cut-branch in the first message so confirmation lives in Apex UI; remaining skill asks stay in the thread.
3. Flag only the Releases button, not Agent Home skill pills.
4. Skill repo and branch come from admin `project_skill_settings` only. Do not hardcode `tbi/55352-phase-3-service-now-cab-ticket`.
5. Normalize Apex titles such as `MV 2026.15.0` to version `2026.15.0` and ref `Release/2026.15.0` before the kickoff reaches the skill.
6. A `cab-release` thread receives a narrow write exception for its Manual Release wiki page, selected snow pipeline, and explicitly confirmed post-snow release branch only.
7. CAB turns run only on the V2 interactive container (`ai-runs-v2-transport`), never inside the App Service, so agent work does not slow Apex for other users. The Releases action is hidden when that flag is off for the project, and `sendMessage` rejects a `cab-release` turn on the legacy route with `422 INTERACTIVE_V2_REQUIRED` instead of running it in-process. Bedrock is not used because the skill must run the MaxView repository scripts.
8. The interactive actor image includes PowerShell. `ADO_PAT` stays on the Apex web app. CAB scripts call `POST /api/internal/cab-release/ado` with the runner credential already used for callbacks. That route forwards only MaxView release-ref, prod-cd, work-item read, Manual Release wiki, and snow pipeline 670/595 calls. A wiki write must name `/Manual Release/{version}`; a read may still use the parent page. A build read by id is forwarded only after that build is confirmed as `mv-prod-cd` on `Release/{version}` or `development`, or as snow pipeline 670 or 595. Snow status and log reads use that second check because those runs are queued on the branch that contains the payload script. The release branch is created through that ref call, not by `git push`. The image does not install a git credential helper, because the container has no `ADO_PAT`. `REPO_READ_SERVICE_TOKEN` is not an Azure DevOps credential.

## Feature Flag

- **Flag key**: `release-cab-request` (create in Platform Admin → Feature Flags)
- **Server gating**: none
- **Client gating**: `useFeatureFlag('release-cab-request', project)` and `useFeatureFlag('ai-runs-v2-transport', project)` on `ReleaseCabRequestAction`
- **Disabled path**: omit the Actions item, modal, and panel (`null`)
- **Targeting**: MaxView project (and users/groups as needed)
- **Cleanup**: retain enabled after two stable sprints at full rollout

## Phase Summary and Parallelization

```mermaid
flowchart LR
  p1a[1a modal]
  p1b[1b kickoff text]
  p1c[1c flag entry]
  p2a[2a panel]
  p2b[2b ReleaseView wire]

  p1a --> p2a
  p1b --> p2a
  p1c --> p2b
  p2a --> p2b
```

Phase 1 tasks have no dependencies on each other. Phase 2 starts after Phase 1 type-check and tests.

## Files Changed / Created

| Action | Path |
|--------|------|
| Create | `design-docs/release-cab-request.md` |
| Create | `src/client/utils/cabReleaseKickoff.ts` |
| Create | `src/client/utils/__tests__/cabReleaseKickoff.test.ts` |
| Create | `src/client/components/CreateCabRequestModal.tsx` |
| Create | `src/client/components/CreateCabRequestModal.module.css` |
| Create | `src/client/components/__tests__/CreateCabRequestModal.test.tsx` |
| Create | `src/client/components/ReleaseCabRequestAction.tsx` |
| Create | `src/client/components/__tests__/ReleaseCabRequestAction.test.tsx` |
| Create | `src/client/components/CabReleaseAssistantPanel.tsx` |
| Create | `src/client/components/CabReleaseAssistantPanel.module.css` |
| Create | `src/client/components/__tests__/CabReleaseAssistantPanel.test.tsx` |
| Create | `src/shared/utils/cabReleaseSkill.ts` |
| Edit | `src/server/services/chatAgentService.ts` |
| Edit | `src/server/services/durableInteractiveTurnService.ts` |
| Edit | `src/shared/utils/chatProgressCopy.ts` |
| Edit | `runners/ai-runs-interactive/Dockerfile` |
| Edit | `infra/ai-runs-interactive.tf` |
| Edit | `src/client/components/ReleaseView.tsx` |
| Edit | `src/client/components/__tests__/ReleaseView.delete.test.tsx` (and related if needed) |
