# Apex Screen Inventory

**Surface:** `src/client` (React, CSS Modules / App.css tokens, TanStack Query, react-router-dom)  
**Project:** Apex only — do **not** copy into MaxView.  
**Used by:** Apex Project Skill Settings → `screenInventoryPath`  
**Maintained with:** design-system skill (`.cursor/skills/design-system/SKILL.md`)

---

## Column key

| Column | Meaning |
|--------|---------|
| **Route** | React Router URL path(s). Prefer a single primary route for EXTEND / screenshot lookup |
| **Component / File** | Main component under `src/client/components/` (or App shell) |
| **Purpose** | One-sentence description of the page's job |
| **Personas** | Who uses this screen (BA / UI-UX / Dev / Admin / Super Admin) |
| **Key components** | Notable child components |
| **Archetype** | Hub / List / Detail / Form / Dashboard / Calendar |
| **States** | Empty / error / loading summary |
| **Last updated** | ISO date |

---

## Shell / entry

| Route | Component / File | Purpose | Personas | Key components | Archetype | States | Last updated |
|-------|------------------|---------|----------|----------------|-----------|--------|--------------|
| `/` | `App.tsx` | Project selector before entering the app shell | All | project cards | Hub | empty: no projects; loading: project fetch | 2026-07-30 |
| `/home` | `AgentHome.tsx` | Agent Home — start chats, skill pills, recent threads | BA, Dev, Admin | skill pills, thread list | Hub | empty: no threads; loading: skeletons | 2026-07-30 |
| `/platform-admin` | `PlatformAdmin.tsx` | Cross-project platform admin (flags, menu, access) | Super Admin | feature flags, menu settings | Hub | — | 2026-07-30 |
| `/notifications` | `NotificationsPage.tsx` | Full notification center | All (with permission) | notification list | List | empty: no notifications | 2026-07-30 |

---

## Calendar & planning

| Route | Component / File | Purpose | Personas | Key components | Archetype | States | Last updated |
|-------|------------------|---------|----------|----------------|-----------|--------|--------------|
| `/calendar` | `ScrumCalendar.tsx` | Sprint calendar + unscheduled backlog side panel | Dev, Admin | UnscheduledList, DetailsPanel | Calendar | empty: no work items; loading: calendar skeleton | 2026-07-30 |
| `/planning/dev-stats` | `DevStats.tsx` | Developer productivity stats | Admin, Dev lead | charts | Dashboard | empty/error/loading | 2026-07-30 |
| `/planning/qa` | `QAMetrics.tsx` | QA metrics | Admin, QA | charts | Dashboard | empty/error/loading | 2026-07-30 |
| `/planning/ai-analysis` | `AIAnalysis.tsx` | AI analysis views | Admin | charts | Dashboard | empty/error/loading | 2026-07-30 |
| `/planning/roadmap` | `RoadmapView.tsx` | Product roadmap | Admin, BA | roadmap board | Dashboard | empty/loading | 2026-07-30 |
| `/planning/releases` | `ReleaseView.tsx` | Release tracking | Admin, BA | release list | List | empty/loading | 2026-07-30 |

---

## Cost & analytics

| Route | Component / File | Purpose | Personas | Key components | Archetype | States | Last updated |
|-------|------------------|---------|----------|----------------|-----------|--------|--------------|
| `/cloud-cost` | `CloudCost.tsx` | Azure cloud cost tracking | Admin | cost charts | Dashboard | empty/error/loading | 2026-07-30 |
| `/ai-cost` | AI cost views | AI usage / cost analytics | Admin | drill-down tables | Dashboard | empty/error/loading | 2026-07-30 |

---

## Interview → PRD → Design Plan → Prototype → Design Doc

| Route | Component / File | Purpose | Personas | Key components | Archetype | States | Last updated |
|-------|------------------|---------|----------|----------------|-----------|--------|--------------|
| `/backlog` | `InterviewsDashboard.tsx` | Dashboard for interviews, PRDs, prototypes, design docs | BA, UI-UX, Dev | group cards | Hub | empty: no interviews | 2026-07-30 |
| `/backlog/interview/:id` | `InterviewChatView.tsx` | AI-guided design interview | BA | chat stream, section owners | Detail | loading/error | 2026-07-30 |
| `/backlog/prd/:id` | `PrdReviewView.tsx` | PRD review and approval | BA | backlog viewer, approvers | Detail | loading/error | 2026-07-30 |
| `/backlog/design-plan/:id` | `DesignPlanReviewView.tsx` | Per-feature design plan (decision, route, screenshot, brief) | UI-UX | plan editor, PageScreenshotField | Detail | generating/ready/error | 2026-07-30 |
| `/backlog/design-prototypes/:id` | `DesignPrototypeReviewView.tsx` | HTML prototype review per feature | UI-UX | iframe preview, comments | Detail | generating/ready/error | 2026-07-30 |
| `/backlog/design-doc/:id` | `DesignDocReviewView.tsx` | Technical design doc review | Dev lead | markdown review, comments | Detail | loading/error | 2026-07-30 |

---

## ADR

| Route | Component / File | Purpose | Personas | Key components | Archetype | States | Last updated |
|-------|------------------|---------|----------|----------------|-----------|--------|--------------|
| `/adr` | `AdrsDashboard.tsx` | ADR list / dashboard | Dev, Architect | ADR cards | List | empty: no ADRs | 2026-07-30 |
| `/adr/:id` | `AdrChatView.tsx` | ADR interview / finalize thread | Dev, Architect | chat stream | Detail | loading/error | 2026-07-30 |

---

## My Work / Standup / Labs

| Route | Component / File | Purpose | Personas | Key components | Archetype | States | Last updated |
|-------|------------------|---------|----------|----------------|-----------|--------|--------------|
| `/my-work` | `DevWorkbenchView.tsx` | Developer workbench of assigned items | Dev | work item list | Hub | empty: no work | 2026-07-30 |
| `/my-work/session/:id` | `DevSessionView.tsx` | Active implementation session | Dev | session timeline | Detail | loading/error | 2026-07-30 |
| `/standup` | `StandupCeremonyView.tsx` | Daily standup participant view | Team | update form | Form | empty/loading | 2026-07-30 |
| `/standup/manage` | `StandupManageView.tsx` | Configure standup ceremony | Admin | schedule form | Form | — | 2026-07-30 |
| `/standup/summary` | `StandupSummaryView.tsx` | Facilitator summary | Team, Admin | summary cards | Detail | — | 2026-07-30 |
| `/ui-lab` | `UiLabView.tsx` | UI Lab generation / review | UI-UX | design list, preview | Hub | empty: no designs | 2026-07-30 |
| `/design-module` | `DesignModuleView.tsx` | Design module library | UI-UX, Admin | module cards | Hub | empty/loading | 2026-07-30 |
| `/feature-requests` | `FeatureRequestsView.tsx` | Apex Backlog feature request triage | BA, Admin | request list/detail | List | empty/loading | 2026-07-30 |

---

## Project admin

| Route | Component / File | Purpose | Personas | Key components | Archetype | States | Last updated |
|-------|------------------|---------|----------|----------------|-----------|--------|--------------|
| `/admin/roles` | `AdminRoles.tsx` | Manage roles and permissions | Admin | role matrix | Form | — | 2026-07-30 |
| `/admin/users` | `AdminUsers.tsx` | Manage users and role assignment | Admin | user table | List | empty: no users | 2026-07-30 |
| `/admin/groups` | `AdminGroups.tsx` | Manage groups | Admin | group list | List | empty: no groups | 2026-07-30 |
| `/admin/project-settings` | `AdminProjectSettings.tsx` | Skill repo, prototype design-system path, models | Admin | settings form | Form | — | 2026-07-30 |
| `/admin/notifications` | Admin notification settings | Project notification config | Admin | prefs form | Form | — | 2026-07-30 |
