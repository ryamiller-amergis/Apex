# Apex — Product Context Guide

## What is Apex?

Apex (formerly AI-Pilot) is an internal product-building and project-management platform that centralizes the software delivery lifecycle into a single AI-enhanced application. It connects Azure DevOps work items, AI-guided design interviews, automated PRD generation, design doc workflows, daily standups, planning analytics, and cloud cost tracking into one cohesive experience — replacing fragmented manual processes with streamlined, AI-assisted workflows.

**Core value proposition:** Apex eliminates context-switching between disconnected tools by bringing work item management, document generation, review workflows, team ceremonies, and analytics into one platform — with AI agents that automate repetitive tasks, enforce consistency, and surface insights that would otherwise require manual effort.

## Key Features

### 1. AI-Guided Design Interviews

Apex provides a structured interview workflow where a BA, Product Owner, or Manager starts a design interview with an AI agent. The agent uses the `/grill-with-docs` skill to challenge design decisions, ask clarifying questions, and capture requirements through a multi-turn conversation grounded in project context (architecture docs, ADRs, UI knowledge base).

- **Start an interview** from the Interview dashboard (requires BA, Manager, or Product Owner group membership)
- **Select reviewers** at kickoff — PRD, Design Doc, Design Prototype, and QA reviewers are assigned upfront
- **Mark complete** when the conversation has captured sufficient requirements
- **Generate a PRD** with one click from a completed interview — the AI uses the `/to-prd` skill to produce a structured PRD with epics, features, PBIs, and TBIs organized into delivery waves

### 2. PRD Generation & Review

PRDs are automatically generated from interview transcripts by an AI agent. The output includes a structured markdown document and a `backlog.json` with a full work item hierarchy.

- **Inline review comments** — reviewers highlight text and leave threaded comments; approval is blocked until all comments are resolved
- **Apex Assistant** — a slide-out AI chat panel pre-loaded with the PRD, backlog, and all reviewer comments that can bulk-address feedback and propose content changes with GitHub-style diff review (Accept/Reject)
- **Two-step approval** — assigned reviewers approve first, then the document owner gives final approval
- **Per-section editing** — hover a section heading to edit just that section; backlog items are also editable inline
- **Test case generation** — AI generates QA test cases from the PRD; QA reviewers can approve them independently

### 3. Design Documents

Design docs are generated automatically when a design prototype is approved, grounded in the interview transcript, PRD, and prototype HTML.

- **AI validation** — a configurable validation skill produces a structured scorecard; approval is blocked until the score reaches 90%
- **AI fix** — users can trigger an AI-powered fix for validation gaps with a side-by-side review panel
- **Per-feature docs** — when a PRD covers multiple features, separate design docs are created per feature
- **Mermaid diagrams** — generated design docs render Mermaid diagrams with theme-aware styling
- **Design Doc Assistant** — persistent AI chat panel for interactive editing and refinement

### 4. Design Prototypes

Design prototypes are generated as interactive HTML from approved features, providing a visual reference for developers and stakeholders.

- **AI model audit trail** — records which AI model was used for generation
- **Review workflow** — prototypes go through the same two-step approval process as PRDs and design docs

### 5. Azure DevOps Integration & Export

Apex deeply integrates with Azure DevOps for work item management and export.

- **Calendar view** — month and week views with drag-and-drop to schedule/unschedule work items by due date
- **Hierarchical backlog** — Epic → Feature → PBI/Bug tree with expand/collapse, filtered by iteration, type, assignee, and state
- **Work item details** — comprehensive panel with type-specific fields, rich text, discussions, tags, related items, and navigation history
- **Create in ADO** — exports PRD backlogs to Azure DevOps as PBIs, Features, Technical Backlog Items, dependency links, attached design docs, prototype HTML, and QA test cases
- **Selective PBI creation** — push individual approved PBIs to ADO without creating the entire epic hierarchy
- **Two-way sync** — changes in Azure DevOps are reflected in the app within the polling interval

### 6. Daily Standup Ceremonies

AI-facilitated daily standups where each team member interacts with a personal standup agent.

- **Automated context** — the agent queries the participant's active work items and yesterday's changes from Azure DevOps, then verifies status accuracy rather than passively reading back a list
- **Release awareness** — release-targeted items are highlighted; missing target dates are flagged as actionable gaps
- **Facilitator agent** — automatically summarizes team updates, creates cross-cutting follow-up discussions, and publishes a session summary
- **Standup Management** — admins configure scheduled standups per project and group, run sessions on demand, trigger the facilitator early, and review session status
- **Standup Summary** — completed session summaries and follow-up items for the team
- **Notifications** — participants receive in-app and Teams notifications when a session starts, with periodic reminders until they submit

### 7. Planning & Analytics

A suite of planning tools for delivery teams:

- **Developer Stats** — individual developer metrics and workload analysis
- **QA Metrics** — QA team performance and testing throughput
- **AI Analysis** — AI-powered analysis of work item patterns and delivery health
- **Roadmap** — visual timeline with sticky work item columns and horizontal scrolling for 12+ months
- **Releases** — release epic management with progress tracking, delete functionality, and child item counts
- **Cycle Time** — analytics for measuring how long work items take through the pipeline

### 8. Cloud Cost Tracking

Per-project Azure cloud cost visualization and analysis.

### 9. Feature Requests

A global submission system where any authenticated user can request product features, with an Apex-team-only review module.

- **Global submit** — a floating action button lets any user submit a feature request with title, description, and expected advantage
- **AI analysis** — each request is automatically analyzed by an AI skill that suggests priority (low/medium/high/critical), risk (low/medium/high), and rationale
- **Team triage** — Apex admins review requests with AI suggestions, override priority/risk, change status, and manually re-rank
- **Notifications** — Apex reviewers receive in-app and Teams notifications when new requests are submitted

### 10. In-App Notification Center

Real-time notification system with SSE delivery.

- **Bell icon** with unread badge in the header
- **Notification center** — dropdown panel listing notifications grouped by date
- **Toast popups** — fixed bottom-right stack (max 3, auto-dismiss 5s)
- **Per-type preferences** — users toggle notifications and toast alerts on/off per type (system, AI, user-action, background)
- **Teams integration** — notifications also delivered via Microsoft Teams Bot Framework

### 11. Feature Flag Management

Platform admins can create and manage feature flags for targeted rollout.

- **Targeting rules** — flags can target everyone, specific projects, users, or groups
- **Enable/disable toggles** — kill switch per flag
- **Lifecycle status** — active, stale, archived with full audit log
- **Client evaluation** — `useFeatureFlag` hook evaluates flags per user and project so rollouts can be scoped without redeploying

### 12. My Work (Developer Workbench)

A developer-focused view for managing personal work items and development sessions (visible to users in the Developer group).

### 13. What's New / Changelog

- **Auto-popup** — What's New modal opens automatically after each deployment if there's a new release
- **Non-blocking banner** on the project selector page
- **User control** — "Show automatically on login" toggle; unread indicator on the profile icon
- **Server-tracked** — release version synced through a server-side setting via database migration

## User Workflows

### How do I start a design interview?

1. Navigate to **Interview** in the nav bar
2. Click **Start New Interview** (requires BA, Manager, or Product Owner group membership)
3. Select reviewers for PRD, Design Doc, Design Prototype, and QA
4. Choose an AI model if different from the project default
5. The AI agent begins a structured interview, challenging your design decisions and capturing requirements
6. When done, click **Mark Complete**
7. Click **Generate PRD** to produce a structured PRD from the interview

### How do I review a PRD?

1. Navigate to **Interview** → **PRDs** tab
2. Click on a PRD with "Pending Review" status
3. Read the PRD in the Preview tab; highlight text to leave inline comments
4. Use the Backlog tab to review the generated work item hierarchy
5. Once all comments are resolved, click **Approve** (or **Request Revision** with feedback)
6. The document owner gives final approval after all reviewers approve

### How do I submit my daily standup?

1. Navigate to **Standup** in the nav bar (when a session is active)
2. An AI agent presents your yesterday's ADO activity and current assignments
3. Verify/correct the information, discuss today's plans and any blockers
4. The agent produces a structured summary and submits your update
5. After all participants submit (or the deadline is reached), the facilitator generates a team summary

### How do I request a feature?

1. Click the floating **Request a Feature** button (available on any page)
2. Fill in the title, what you want, and what advantage it would bring
3. Submit — Apex admins are notified and an AI automatically analyzes priority and risk
4. Track your request's status through the Feature Requests module (Apex project only)

### How do I get notified?

1. Notifications appear automatically via the **bell icon** in the header
2. Toast popups appear for real-time events (assignment, approval, standup reminders)
3. Configure preferences in the **Notifications** page — toggle per-type notifications and toast alerts
4. Teams notifications are delivered automatically if the Teams bot is configured

### How do I manage work items on the calendar?

1. Navigate to **Calendar** in the nav bar
2. Drag work items from the unscheduled sidebar onto calendar dates to set due dates
3. Drag items back to unscheduled to clear due dates
4. Click any item to open the details panel for editing
5. Use filters to narrow by iteration, work item type, assignee, or state

## How Apex Cuts Down Workflows

### Before Apex (Manual / Fragmented)

- **Design interviews** required scheduling meetings, taking notes in Word/OneNote, and manually writing PRDs in separate documents
- **PRD reviews** happened via email chains or Word comments with no structured approval workflow
- **Design docs** were written from scratch by developers, often missing requirements
- **Standups** were verbal meetings with no persistent record, no ADO status verification, and no automated follow-up
- **Work item tracking** required switching between ADO, email, and spreadsheets
- **Feature requests** went into email, Slack, or got lost entirely
- **Release planning** involved manual cross-referencing of work items, dates, and dependencies

### With Apex (Streamlined)

- **Design interviews** are AI-guided conversations that challenge assumptions and capture requirements in a structured format — no scheduling, no manual note-taking
- **PRDs are auto-generated** from interviews with a full backlog hierarchy, then exported directly to ADO — what took days now takes minutes
- **Design docs generate automatically** when prototypes are approved, grounded in the actual interview and PRD — no starting from a blank page
- **Standups are AI-facilitated** with ADO context pre-loaded, status accuracy verified proactively, and structured summaries produced automatically
- **One platform** for work items, docs, reviews, analytics, and notifications — no context-switching
- **Feature requests** are submitted, AI-analyzed, and triaged in one place with priority/risk suggestions
- **Release tracking** is visual and connected to actual work item data

## How Apex Enhances User Experience

- **Centralized platform** — everything lives in one place with consistent navigation and search
- **Consistent UI** — all views share the same design language, theming (Light/Dark/Amergis), and interaction patterns
- **Real-time updates** — SSE-powered notifications, live chat streaming, and polling-based ADO sync keep everything current
- **Role-based access** — admins can assign global roles or project-specific roles; project roles override global roles when present so access and navigation can differ by project
- **AI assistance everywhere** — from interviews to PRD generation to design doc validation to standup facilitation, AI agents reduce manual effort at every step
- **Mobile responsive** — hamburger menu and responsive layouts work on mobile devices
- **Accessible** — keyboard navigation, ARIA labels, and focus management throughout

## Architecture Overview

### Frontend
- **React 18** with TypeScript
- **Vite** for development and production builds
- **React Router** for client-side routing
- **TanStack Query** for server state management
- **React DnD** for drag-and-drop (calendar, backlog)
- **CSS Modules** for component styles (CSS custom properties for theming)
- **Code splitting** via React.lazy + Suspense for all major views
- **ErrorBoundary** wrapping for graceful error handling

### Backend
- **Express** with TypeScript
- **PostgreSQL** via **Drizzle ORM** for all data persistence
- **node-pg-migrate** for database migrations
- **Azure DevOps API** (`azure-devops-node-api`) for work item operations
- **Cursor SDK** (`@cursor/sdk`) for AI agent interactions
- **AWS Bedrock** for additional AI model access
- **Server-Sent Events (SSE)** for real-time notification delivery
- **Microsoft Bot Framework** for Teams notifications
- **Azure Application Insights** for telemetry

### Data Storage
- **PostgreSQL** — all persistent data: users, roles, permissions, chat threads, interviews, PRDs, design docs, notifications, feature flags, feature requests, standup sessions, project settings
- **Azure DevOps** — work items, iterations, area paths (accessed via API, not stored locally)

### AI Integration
- **Cursor SDK agents** — used for design interviews, PRD generation, design doc generation, validation, standup facilitation, feature request analysis, and the Ask Apex assistant
- **Skill-based workflows** — each AI capability is defined by a SKILL.md file that provides instructions and procedure; skills are configurable per project
- **Per-project model selection** — admins can override the default AI model per project and per workflow

## Modules & Navigation

| Nav Item | Route | Permission | Description |
|----------|-------|------------|-------------|
| Home | `/home` | (any authenticated user) | Agent chat home with skill pills for guided conversations |
| Calendar | `/calendar` | `calendar:view` + menu enabled | Work item calendar with drag-and-drop scheduling |
| Planning | `/planning/*` | `planning:view` + menu enabled | Analytics tabs: Dev Stats, QA Metrics, AI Analysis, Roadmap, Releases |
| Cloud Cost | `/cloud-cost` | `cost:view` + menu enabled | Azure cloud cost visualization |
| Interview | `/backlog` | `interviews:view` + menu enabled | Interview dashboard, PRD review, design docs, prototypes |
| My Work | `/my-work` | `dev-workbench:view` + Developer group + menu enabled | Developer workbench and sessions |
| Standup | `/standup` | `standup:participate` + menu enabled | Daily standup ceremony participation |
| Feature Requests | `/feature-requests` | `feature-requests:view` + Apex project only + menu enabled | Feature request review and triage (Apex admins) |
| Admin | `/admin/*` | `admin:roles` | Roles, Users, Groups, Project Settings, Notifications |
| Platform Admin | `/platform-admin` | Super admin only | Access & Users, Menu Visibility, Feature Flags |

Navigation is controlled by three layers:
1. **RBAC permissions** — determined from project-specific roles when assigned, otherwise from global roles; permissions refresh when the user switches projects
2. **Menu visibility** — per-project menu settings configured in Platform Admin control which modules appear
3. **Group membership** — some modules (My Work, Standup) require membership in specific groups

## Admin Capabilities

### Project Admin (`/admin`)
- **Roles** — create, edit, delete roles; manage permission assignments per role
- **Users** — view project users and assign/revoke global or project-specific roles; project assignments override global roles for that project
- **Groups** — manage project groups (Developer, BA, QA, etc.) that gate certain features; member selection is limited to users assigned to the active project
- **Project Settings** — per-project configuration for AI skills, models, approval mode, designated approvers
- **Notifications** — admin notification management

### Platform Admin (`/platform-admin`, super admin only)
- **Access & Users** — manage project access requests and pending email assignments
- **Menu Visibility** — toggle which modules are visible per project
- **Feature Flags** — create flags with targeting rules, enable/disable toggles, lifecycle management, audit log

## AI Capabilities

| Capability | Skill | What it Does |
|-----------|-------|-------------|
| Design Interview | `/grill-with-docs` | Structured interview that challenges design decisions using project context |
| PRD Generation | `/to-prd` | Generates structured PRD + backlog hierarchy from interview transcript |
| Design Doc Generation | (project-configured) | Auto-generates design docs from approved prototypes |
| Design Doc Validation | (project-configured) | Scores design docs against a validation rubric; blocks approval below 90% |
| Design Doc Fix | (project-configured) | Proposes targeted edits to fix validation gaps |
| Daily Standup | Daily Standup skill | Facilitates individual standup conversations with ADO context |
| Standup Facilitation | Facilitator skill | Summarizes team updates and creates cross-cutting follow-ups |
| Feature Request Analysis | Feature Request Analysis skill | Suggests priority, risk, and rationale for submitted requests |
| PRD Assistant | (contextual) | Bulk-addresses reviewer feedback with proposed content changes |
| Ask Apex | (this agent) | Product knowledge assistant that helps users understand and navigate Apex |

Each AI capability can be configured per project with a specific skill path and model in Admin → Project Settings. The system supports Cursor SDK models and AWS Bedrock models.
