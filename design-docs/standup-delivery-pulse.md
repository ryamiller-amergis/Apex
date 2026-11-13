# Standup Delivery Pulse (SDLC-Aware, Multi-Day & Pre-Drafted Standups)

## Overview

Apex's Daily Standup module (`standupService.ts`, `chatAgentService.ts`, `.cursor/skills/daily-standup/SKILL.md`, `StandupCeremonyView.tsx`, `StandupSummaryView.tsx`, `StandupManageView.tsx`) previously hardcoded a single team's release-date rules ("never mention sprints — this team uses release target dates"), required participants to recite status in a multi-turn chat, and dead-ended on `/standup-summary` without `?session=`.

**Standup Delivery Pulse** lives entirely inside the Standup module (`/standup`, `/standup-summary`, `/standup-manage`) — leaving `/calendar` untouched — and delivers:

1. **Configurable Delivery Models (`flow`, `sprint`, `milestone`, `support`, `custom`)**: Teams pick how delivery risk is evaluated, defaulting to `flow` (Kanban aging, WIP limits, and blockers) without requiring per-item target dates unless `milestone` mode or `enableTargetDateChecks` is configured.
2. **Hybrid ADO + Group Roster Discovery (`rosterMode`)**: Standup configs can auto-discover active contributors from Azure DevOps work items (`ado_and_groups` default or `ado_active`) or restrict strictly to configured Apex groups (`groups_only`), with live roster preview in `/standup-manage`.
3. **Pre-Drafted Individual Standups with Approve / Reject & Inline Corrections**: When a session opens, Apex pre-drafts yesterday's completions, today's focus items, and blockers from ADO work items, Git PRs, build timelines, and multi-day history. Participants can approve in one click, reject inaccurate drafted items, add explicit `userCorrections`, or switch to `Discuss with Coach` (`useAgentChatSession`).
4. **Multi-Day Individual Memory & Spoken-Ready Per-Person Narratives**: Tracks up to the last 7 standup sessions per participant to detect multi-day carryover streaks and completions, and synthesizes ready-to-read `individualNarratives` for every participant (`confirmed` once submitted, or `ai_drafted` from ADO before they submit).
5. **SDLC-Aware Facilitator Intelligence & 5-Minute Team Pulse Board**: Inspects PR changed files and pipeline stage timelines to surface SQL migration release checks (`migrations/**`, `*.sql`), Terraform/IaC pipeline verification alerts (`*.tf`, `infra/**` without a passing IaC stage), red builds on QA items, missing test updates, engineering area breakdowns (`Database / SQL`, `Infra / Terraform`, `Backend / API`, `Frontend / UI`, `QA & Testing`, `Security & Auth`, `Prod Support`), and confirmation-gated ADO field proposals.

---

## Delivery Models & Roster Modes

### Delivery Policy Matrix

| Delivery Model | Default `enableTargetDateChecks` | Default `wipLimitPerPerson` | Default `slaHoursHighPriority` | Primary Risk Signals |
| --- | --- | --- | --- | --- |
| `flow` (Default) | `false` | `3` | `null` | Stale interim state (`> staleDaysThreshold`), WIP overload, PR merge lag, PR review wait, pipeline failure, multi-day carryover |
| `sprint` | `false` | `null` | `null` | Stale state, sprint scope mismatch, carryover streaks, PR lag/review wait, pipeline failure |
| `milestone` | `true` | `null` | `null` | Missing target date on active/release items, target date within 7 days in early state (`New`, `Active`, `In PR`), overdue deadline, stale state |
| `support` | `false` | `null` | `24` | SLA age breach on bugs/incidents (`> slaHoursHighPriority`), stale state, production blockers |
| `custom` | `false` | `null` | `null` | User-selected combination of `StandupDeliveryPolicy` toggles and thresholds |

### Roster Discovery Modes (`rosterMode`)

| Mode | Group Requirement | Resolution Rule |
| --- | --- | --- |
| `ado_and_groups` (Default) | Optional (`groupIds` may be empty) | Union of members in `groupIds` and active ADO contributors (`AssignedTo` open items or `ChangedBy` in last 7 days) matched by email to `app_users` |
| `ado_active` | Optional filter (`groupIds` may be empty) | Active ADO contributors matched to `app_users`, intersected with `groupIds` when `groupIds` is non-empty |
| `groups_only` | Required (non-empty `groupIds`) | Strictly members of configured `groupIds` |

---

## Data Model & Schema Changes

Migration: `migrations/20261113120000_standup-delivery-pulse.sql` (reversible `-- Up Migration` and `-- Down Migration`).

1. **`standup_configs`** (adds 5 columns; total 23 columns, well under the 50-column ceiling):
   - `delivery_model TEXT NOT NULL DEFAULT 'flow'`
   - `goal_source TEXT NOT NULL DEFAULT 'none'`
   - `team_goal TEXT`
   - `roster_mode TEXT NOT NULL DEFAULT 'ado_and_groups'`
   - `policy JSONB NOT NULL DEFAULT '{}'::jsonb`
2. **`standup_sessions`** (adds 1 column; total 12 columns):
   - `team_pulse JSONB` (`StandupTeamPulse` including `sdlcCallouts`, `areaBreakdown`, and `individualNarratives`)
3. **`standup_participants`** (adds 1 column; total 11 columns):
   - `prepared_brief JSONB` (`ParticipantPreparedBrief` including `draftedItems`, `recommendedFocus`, `multiDayArc`, `workDomains`, and `sdlcCallouts`)
4. **`standup_action_proposals`** (new table; 16 columns):
   - Stores confirmation-gated ADO field proposals (`pending` -> `applied` | `dismissed`) with `decided_by` and `decided_at` audit columns.

No columns are added to `project_skill_settings`, and `/calendar` files remain identical to `main`.

---

## Acceptance Criteria & Test Traceability

| ID | Acceptance Criterion | Verification Coverage |
| --- | --- | --- |
| `AC-01` | Generic Delivery Models (`flow` default, `sprint`, `milestone`, `support`, `custom`) + hybrid `rosterMode` (`ado_and_groups`, `ado_active`, `groups_only`); no target-date nagging when disabled | `standupDeliveryPolicyService.test.ts`, `standupRoutes.test.ts`, `standup-delivery-pulse.spec.ts` |
| `AC-02` | Multi-day memory (up to 7 sessions), carryover streaks, ADO/GitHub PR changed files, and pipeline stage timelines populate `preparedBrief` | `standupDeliveryPolicyService.test.ts`, `standupService.test.ts`, `standup-delivery-pulse.spec.ts` |
| `AC-03` | Pre-drafted individual standup on `/standup` with per-item Approve / Reject buttons, inline `userCorrections`, Reject All & Write Manually, and `Discuss with Coach` chat toggle | `StandupCeremonyView.test.tsx`, `standup-delivery-pulse.spec.ts` (Test 1) |
| `AC-04` | SDLC & release evaluators flag `.sql` migrations, `.tf` IaC changes without passing Terraform/IaC pipeline stages, red builds in QA states, missing tests, and Milestone target-date risks | `standupDeliveryPolicyService.test.ts`, `standup-delivery-pulse.spec.ts` (Test 3) |
| `AC-05` | Policy- and SDLC-aware prompts (`buildStandupParticipantPrompt`, `buildStandupFacilitatorPrompt`, `get_standup_session`, `.cursor/skills/daily-standup/SKILL.md`) | `standupDeliveryPolicyService.test.ts`, `standupService.test.ts` |
| `AC-06` | `/standup-summary` without `?session=` loads the latest project session and renders Team Goal, SDLC Callouts, Blockers, Engineering Area Breakdown, and Multi-Day Individual Narratives (`confirmed` + `ai_drafted`) | `StandupSummaryView.test.tsx`, `standup-delivery-pulse.spec.ts` (Test 3) |
| `AC-07` | Confirmation-gated ADO proposals require `workitems:write` to apply or `standup:participate` to dismiss, recording audit metadata | `standupRoutes.test.ts`, `standup-delivery-pulse.spec.ts` (Test 3) |
| `AC-08` | `/calendar` remains untouched (`git diff origin/main` empty on Calendar files) and passes `calendar-work-items.spec.ts`; reversible SQL migration passes `up` / `down` / `up` | `calendar-work-items.spec.ts`, `standup-delivery-pulse.integration.test.ts`, `workflow-evaluation-schema.integration.test.ts` |
