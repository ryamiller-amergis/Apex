# Standup & Calendar Delivery Pulse

## Overview

Apex's Daily Standup and Scrum Calendar previously assumed one team's release-date workflow ("never mention sprints — this team uses release target dates") and required every participant to walk through a multi-turn chat to recite work-item status already recorded in Azure DevOps (ADO), pull requests, builds, and prior standups. In addition, `/standup-summary` required a `?session=` query parameter and rendered a flat markdown block, while `/calendar` had no connection to standup outcomes, team goals, delivery risk reasons, or confirmation-gated ADO field proposals.

**Delivery Pulse** turns Daily Standup and Calendar into a policy-driven, exception-first ceremony:

1. **Configurable Delivery Models (`flow`, `sprint`, `milestone`, `support`, `custom`)**: Teams choose how work is measured, defaulting to `flow` (Kanban aging, WIP limits, and blockers) without requiring per-item target dates unless `milestone` mode or `enableTargetDateChecks` is configured.
2. **Pre-Computed Participant Brief & Commitment Memory**: Before a participant opens `/standup`, Apex aggregates work-item changes, PR merge/review signals, build failures, open follow-ups, and yesterday's `today` commitments to flag carryover and status drift.
3. **60-Second Quick Confirm + Optional AI Coach**: Participants review and edit pre-filled accomplishments, focus items, and exceptions, stage optional ADO field proposals, and submit in one click — or switch to `Discuss with Coach` (`useAgentChatSession`) when they want interactive help.
4. **5-Minute Team Pulse Huddle Board**: Opening `/standup-summary` without `?session=` loads the project's latest session and orders sections for a fast team huddle: Blockers & Decisions first, At-Risk & Commitment Carryover second, Handoffs & Capacity third, and Confirmation-Gated ADO Proposals fourth.
5. **Calendar Delivery Pulse Integration**: `/calendar` renders `CalendarDeliveryPulseBar` with the active Delivery Model, Team Goal, risk filter pills (`All Items`, `At Risk`, `Blocked / Stale`, `Pending Proposals`), per-item Delivery Confidence badges with "Why at risk?" explanations, and a confirmation drawer for applying or dismissing staged ADO proposals.

---

## Delivery Models & Policy Matrix

Each `standup_configs` row stores `delivery_model`, `goal_source`, `team_goal`, and `policy` JSONB. `resolveStandupPolicy(deliveryModel, partialPolicy)` normalizes defaults deterministically:

| Delivery Model | Default `enableTargetDateChecks` | Default `wipLimitPerPerson` | Default `slaHoursHighPriority` | Primary Risk Signals |
| --- | --- | --- | --- | --- |
| `flow` (Default) | `false` | `3` | `null` | Stale interim state (`> staleDaysThreshold`), WIP overload, PR merge lag, PR review wait, pipeline failure, untouched commitment |
| `sprint` | `false` | `null` | `null` | Stale state, sprint scope mismatch, carryover, PR lag/review wait, pipeline failure |
| `milestone` | `true` | `null` | `null` | Missing target date on active/release items, target date within 7 days in early state (`New`, `Active`, `In PR`), overdue deadline, stale state |
| `support` | `false` | `null` | `24` | SLA age breach on bugs/incidents (`> slaHoursHighPriority`), stale state, production blockers |
| `custom` | `false` | `null` | `null` | User-selected combination of `StandupDeliveryPolicy` toggles and thresholds |

---

## Data Model & Schema Changes

Migration: `migrations/20261113120000_standup-delivery-pulse.sql` (with full `-- Up Migration` and `-- Down Migration`).

1. **`standup_configs`** (adds 4 columns; total 22 columns, well under the 50-column ceiling):
   - `delivery_model TEXT NOT NULL DEFAULT 'flow'`
   - `goal_source TEXT NOT NULL DEFAULT 'none'`
   - `team_goal TEXT`
   - `policy JSONB NOT NULL DEFAULT '{}'::jsonb`
2. **`standup_sessions`** (adds 1 column; total 12 columns):
   - `team_pulse JSONB` (`StandupTeamPulse`)
3. **`standup_participants`** (adds 1 column; total 11 columns):
   - `prepared_brief JSONB` (`ParticipantPreparedBrief`)
4. **`standup_action_proposals`** (new table; 16 columns):
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `session_id UUID NOT NULL REFERENCES standup_sessions(id) ON DELETE CASCADE`
   - `participant_id UUID REFERENCES standup_participants(id) ON DELETE SET NULL`
   - `project TEXT NOT NULL`
   - `work_item_id INTEGER NOT NULL`
   - `work_item_title TEXT NOT NULL`
   - `proposal_type TEXT NOT NULL` (`'target_date' | 'state' | 'assigned_to'`)
   - `field_name TEXT NOT NULL`
   - `current_value TEXT`
   - `proposed_value TEXT NOT NULL`
   - `reason TEXT NOT NULL`
   - `confidence TEXT NOT NULL DEFAULT 'at_risk'` (`'on_track' | 'uncertain' | 'at_risk'`)
   - `status TEXT NOT NULL DEFAULT 'pending'` (`'pending' | 'applied' | 'dismissed'`)
   - `decided_by TEXT`
   - `decided_at TIMESTAMPTZ`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - Indexes: `idx_standup_action_proposals_session (session_id)` and `idx_standup_action_proposals_project_status (project, status)`.

No columns are added to `project_skill_settings`.

---

## Architecture & Component Flow

### Shared Layer (`src/shared/`)
- `src/shared/types/standup.ts`: Shared contracts (`StandupDeliveryModel`, `StandupGoalSource`, `StandupDeliveryPolicy`, `ParticipantPreparedBrief`, `StandupTeamPulse`, `StandupActionProposal`, `CalendarDeliveryPulseResponse`).
- `src/shared/utils/standupDeliveryPolicy.ts`: Pure deterministic functions shared between server and client:
  - `resolveStandupPolicy(deliveryModel, partialPolicy)`
  - `evaluateParticipantBrief(input)`
  - `synthesizeTeamPulse(input)`
  - `evaluateCalendarItemHealth(workItems, options)`

Sharing `evaluateCalendarItemHealth` allows `/calendar` to combine server-stored standup configuration, session carryover/blocker signals, and pending proposals (`GET /api/standup/delivery-pulse?project=...`) with the client's loaded `workItems` without redundant ADO round-trips.

### Server Layer (`src/server/`)
- `src/server/services/standupDeliveryPolicyService.ts`: Server policy wrapper and session `teamPulse` recomputation helpers.
- `src/server/services/standupEvidenceCollectorService.ts`: Collects work items, recent PRs, failed builds, prior participant commitment memory, and open follow-ups (with graceful fallbacks when ADO credentials or repositories are unavailable in local/test environments) and persists `preparedBrief` on `standup_participants`.
- `src/server/services/standupService.ts`:
  - Populates `preparedBrief` during session creation and on demand.
  - Passes `standupDeliveryModel`, `standupGoalSource`, `standupTeamGoal`, `standupPolicy`, and brief summary in `ChatThreadKickoff`.
  - Extends `submitParticipant(participantId, options)` to accept Quick Confirm `structuredUpdate` and staged `proposals`, recomputing `session.teamPulse` immediately.
  - Updates `completeSession` to synthesize and persist `teamPulse`.
- `src/server/services/chatAgentService.ts` & `.cursor/skills/daily-standup/SKILL.md`:
  - Replaces hardcoded release-date / anti-sprint rules with dynamic instructions tailored to `deliveryModel`, `teamGoal`, and `policy`.
- `src/server/routes/standup.ts`:
  - `GET /api/standup/delivery-pulse` (`requireAnyPermission('standup:participate', 'calendar:view')`)
  - `GET /api/standup/sessions/latest` (`requirePermission('standup:participate')`)
  - `GET /api/standup/sessions/:id` (includes `proposals` and `teamPulse`)
  - `GET /api/standup/my-session` (includes `config`, `preparedBrief`, `structuredUpdate`, `proposals`)
  - `POST /api/standup/participants/:id/refresh-brief`
  - `POST /api/standup/participants/:id/submit` (supports `{ structuredUpdate, proposals }`)
  - `POST /api/standup/proposals/:id/apply` (`requirePermission('workitems:write')`)
  - `POST /api/standup/proposals/:id/dismiss` (`requireAnyPermission('standup:participate', 'workitems:write')`)

### Client Layer (`src/client/`)
- `src/client/hooks/useStandupDeliveryPulse.ts`: TanStack Query hooks and mutations for Delivery Pulse, latest session, brief refresh, Quick Confirm submission, and proposal apply/dismiss.
- `src/client/components/StandupCeremonyView.tsx`: Delivery Model badge, Team Goal callout, `Quick Confirm` vs `Discuss with Coach` toggle, pre-filled brief cards, commitment carryover indicator, opt-in proposal staging checkboxes, and 1-click submit.
- `src/client/components/StandupSummaryView.tsx`: Auto-loads latest session when `?session=` is omitted, session switcher dropdown, and exception-ordered 5-Minute Team Pulse Huddle Board.
- `src/client/components/StandupManageView.tsx`: Delivery Model, Goal Source, Team Goal, and Delivery Policy controls (`NumberStepper` + checkboxes).
- `src/client/components/CalendarDeliveryPulseBar.tsx`, `ScrumCalendar.tsx`, `UnscheduledList.tsx`, `WorkItemCard.tsx`: Delivery Pulse bar, risk filter pills, per-item Delivery Confidence badges with "Why at risk?" popovers, and Proposals Review Drawer.

---

## Acceptance Criteria & Test Traceability

| ID | Acceptance Criterion | Verification Coverage |
| --- | --- | --- |
| `AC-01` | Generic Delivery Models (`flow` default, `sprint`, `milestone`, `support`, `custom`) + `goalSource` and `teamGoal`; missing `targetDate` is not flagged under `flow`/`sprint`/`support` unless `enableTargetDateChecks` is enabled | `standupDeliveryPolicyService.test.ts`, `standupRoutes.test.ts`, `standup-delivery-pulse.spec.ts` (Tests 1 & 2) |
| `AC-02` | `preparedBrief` aggregates ADO work items, PR lag/review wait, pipeline failures, open follow-ups, and prior commitment carryover | `standupDeliveryPolicyService.test.ts`, `standup-delivery-pulse.spec.ts` (Test 1) |
| `AC-03` | 60-second Quick Confirm submission on `/standup` with pre-filled brief, exceptions, and `Discuss with Coach` chat toggle | `StandupCeremonyView.test.tsx`, `standup-delivery-pulse.spec.ts` (Test 1) |
| `AC-04` | Milestone / target-date checks flag missing and at-risk target dates and stage confirmation-gated proposals | `standupDeliveryPolicyService.test.ts`, `standup-delivery-pulse.spec.ts` (Tests 2 & 4) |
| `AC-05` | `buildStandupParticipantPrompt`, `buildStandupFacilitatorPrompt`, and `.cursor/skills/daily-standup/SKILL.md` adapt dynamically to `deliveryModel`, `teamGoal`, and `policy` | `standupDeliveryPolicyService.test.ts`, `standupService.test.ts` |
| `AC-06` | `/standup-summary` without `?session=` loads the latest project session and renders the ordered 5-Minute Team Pulse board | `StandupSummaryView.test.tsx`, `standup-delivery-pulse.spec.ts` (Test 3) |
| `AC-07` | `/calendar` renders `CalendarDeliveryPulseBar`, risk filter pills, and per-item confidence indicators with "Why at risk?" reasons | `CalendarDeliveryPulseBar.test.tsx`, `standup-delivery-pulse.spec.ts` (Test 4) |
| `AC-08` | Staged ADO proposals require explicit confirmation (`workitems:write` to apply) or dismissal and record audit metadata | `standupRoutes.test.ts`, `standup-delivery-pulse.spec.ts` (Tests 3 & 4) |
| `AC-09` | Zero regressions on existing `/calendar` smoke journeys and standup unit tests; reversible SQL migration (`up` / `down` / `up`) | `calendar-work-items.spec.ts`, `schemaTableWidth.test.ts`, `workflow-evaluation-schema.integration.test.ts`, `standup-delivery-pulse.integration.test.ts` |
| `AC-10` | Deterministic `/e2e/seed/standup-delivery-pulse` and Playwright E2E suite run offline without live ADO or AI calls | `e2eSetup.ts`, `standup-delivery-pulse.spec.ts` |
