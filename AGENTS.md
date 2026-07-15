# AGENTS.md — Apex Agent Quick Reference

This file is the first-stop reference for AI agents operating within the Apex codebase. For comprehensive product knowledge, read `context.md` at the repo root.

## Application Summary

Apex is an internal product-building and project-management platform. It centralizes AI-guided design interviews, automated PRD/design doc generation, review workflows, daily standups, planning analytics, Azure DevOps integration, feature request triage, and cloud cost tracking into a single React + Express + PostgreSQL application.

## Feature Map

| Feature | Design Docs | Skills | Key Services | Key Components |
|---------|------------|--------|-------------|----------------|
| Design Interviews | `design-docs/interview-prd-workflow.md` | `.cursor/skills/kick-off/SKILL.md`, `.cursor/skills/grill-with-docs/SKILL.md`, `.cursor/skills/grill-design/SKILL.md` | `interviewService.ts` | `InterviewChatView.tsx`, `InterviewsDashboard.tsx` |
| PRD Generation & Review | `design-docs/interview-prd-workflow.md`, `design-docs/prd-spec-review.md`, `design-docs/prd-generation-ux.md` | `.cursor/skills/to-prd/SKILL.md`, `.cursor/skills/prd-spec-review/SKILL.md`, `.cursor/skills/create-test-case/SKILL.md` | `prdService.ts`, `chatAgentService.ts` | `PrdReviewView.tsx`, `PrdAssistantPanel.tsx`, `BacklogViewer.tsx` |
| Design Documents | `design-docs/claude-design-prototype.md`, `design-docs/per-feature-design-doc-kickoff.md` | `.cursor/skills/prd-design-spec/SKILL.md`, `.cursor/skills/design-spec-review/SKILL.md`, `.cursor/skills/design-doc-validation/SKILL.md` | `designDocService.ts`, `documentValidationService.ts` | `DesignDocReviewView.tsx`, `DesignPrototypeReviewView.tsx` |
| Design Prototypes | `design-docs/claude-design-prototype.md` | — | `designPrototypeService.ts`, `designSystemService.ts` | `DesignPrototypeReviewView.tsx`, `DesignPlanReviewView.tsx` |
| Daily Standups | `design-docs/standup_ceremony_bot_cf0fc810.plan.md` | `.cursor/skills/daily-standup/SKILL.md` | `standupService.ts`, `standupScheduler.ts` | `StandupCeremonyView.tsx`, `StandupManageView.tsx`, `StandupSummaryView.tsx` |
| In-App Notifications | `design-docs/in-app-notifications.md`, `design-docs/ai-completion-notifications.md` | `.cursor/skills/in-app-notifications/SKILL.md` | `notificationService.ts`, `aiCompletionNotifier.ts` | `NotificationBell.tsx`, `NotificationCenter.tsx`, `ToastContainer.tsx` |
| Feature Flags | `design-docs/feature_flags_system_84747609.plan.md` | `.cursor/skills/feature-flags/SKILL.md` | `featureFlagService.ts` | `PlatformAdmin.tsx`, `FeatureFlagDemo.tsx` |
| Feature Requests | `design-docs/feature-requests.md` | `.cursor/skills/feature-request-analysis/SKILL.md` | `featureRequestService.ts`, `featureRequestAnalysisService.ts` | `FeatureRequestsView.tsx`, `FeatureRequestModal.tsx`, `FeatureRequestFab.tsx` |
| RBAC | `design-docs/rbac.md`, `design-docs/menu-view-rbac.md`, `design-docs/per-user-rbac.md` | `.cursor/skills/rbac-management/SKILL.md` | `rbacService.ts` | `AdminRoles.tsx`, `AdminUsers.tsx` |
| Calendar & Work Items | — | — | `azureDevOps.ts` | `ScrumCalendar.tsx`, `UnscheduledList.tsx`, `DetailsPanel.tsx` |
| Planning & Analytics | — | — | `cursorAnalyticsService.ts` | `DevStats.tsx`, `QAMetrics.tsx`, `AIAnalysis.tsx`, `RoadmapView.tsx`, `ReleaseView.tsx` |
| Cloud Cost | — | — | `azureCost.ts` | `CloudCost.tsx` |
| My Work (Dev Workbench) | — | — | — | `DevWorkbenchView.tsx`, `DevSessionView.tsx` |
| Document Approvals | `design-docs/document-approver-assignments.md`, `design-docs/interview-section-owners.md` | — | `documentApprovalService.ts`, `ownerApprovalService.ts` | `ApproverSelectModal.tsx`, `SectionOwnerModal.tsx` |
| Review Comments | — | — | `reviewCommentService.ts` | `ReviewCommentSidebar.tsx`, `AnnotationLayer.tsx` |
| Changelog | — | `.cursor/skills/update-changelog/SKILL.md` | `appSettingsService.ts` | `Changelog.tsx`, `ChangelogBanner.tsx` |
| Project Settings | `design-docs/project-settings-redesign.md`, `design-docs/project-skill-settings.md` | — | `projectSettingsService.ts` | `AdminProjectSettings.tsx` |
| ADO Export | — | — | `azureDevOps.ts` | `CreateAdoItemsModal.tsx` |
| Ask Apex (this agent) | — | — | `askApexService.ts` | `AskApexChat.tsx` |

## Key Terminology

| Term | Meaning |
|------|---------|
| **Interview** | An AI-guided design conversation (using `/grill-with-docs` skill) that captures requirements for a feature or project |
| **PRD** | Product Requirements Document — auto-generated from an interview transcript with epics, features, PBIs, and TBIs |
| **Design Doc** | Technical design document auto-generated from an approved design prototype, grounded in the PRD and interview |
| **Design Prototype** | Interactive HTML prototype generated from approved features |
| **Backlog** | The structured hierarchy of Epics → Features → PBIs/TBIs generated as part of a PRD |
| **Skill** | A `SKILL.md` file that defines an AI agent's procedure, inputs, outputs, and rules for a specific workflow |
| **Skill Pill** | A clickable shortcut button on the Agent Home page that routes messages through a specific skill and model |
| **PBI** | Product Backlog Item (Azure DevOps work item type) |
| **TBI** | Technical Backlog Item (Azure DevOps work item type) |
| **RBAC** | Role-Based Access Control — permissions assigned to roles; users may have global roles or project-specific roles that override global roles for that project |
| **Super Admin** | A platform-level administrator who bypasses all menu visibility and most permission checks |
| **Platform Admin** | The admin panel for cross-project settings: access management, menu visibility, feature flags |
| **Project Admin** | Per-project admin panel for roles, users, groups, project settings, and notifications |
| **Apex (project)** | The virtual project representing the AI-Pilot platform itself; feature request review is scoped to this project |
| **Feature Flag** | A runtime toggle that gates feature access by user, project, or group without redeploying |
| **SSE** | Server-Sent Events — used for real-time notification delivery and chat streaming |
| **Facilitator** | The standup agent that summarizes team updates after all participants submit or the deadline is reached |

## Directory Structure

```
src/
├── client/                  # React frontend
│   ├── components/          # UI components (100+ files)
│   ├── hooks/               # Custom React hooks (TanStack Query, feature flags, etc.)
│   ├── contexts/            # React contexts (NotificationContext)
│   ├── config/              # Client config (env, models, release)
│   └── App.tsx              # Root component with routing
├── server/                  # Express backend
│   ├── services/            # Business logic (60+ files)
│   ├── routes/              # Express route handlers
│   ├── db/                  # Drizzle ORM setup and schema
│   ├── middleware/           # Auth, RBAC, error handling
│   └── index.ts             # Server entry point
├── shared/                  # Shared TypeScript types
│   └── types/               # Type definitions used by both client and server
├── .cursor/
│   ├── skills/              # Agent skill definitions
│   └── rules/               # Cursor rules for coding standards
├── design-docs/             # Feature design documents and plans
├── migrations/              # SQL migration files (node-pg-migrate)
├── public/
│   └── CHANGELOG.json       # Release history
├── context.md               # Comprehensive product guide (read this first)
└── AGENTS.md                # This file
```

## Common Questions & Where to Find Answers

| Question | Where to Look |
|----------|--------------|
| What features does Apex have? | `context.md` → Key Features section |
| How does a specific feature work? | Feature map above → design doc + service file |
| What permissions exist? | `.cursor/rules/rbac-governance.mdc` → Permission Catalog |
| What changed recently? | `public/CHANGELOG.json` (newest entries first) |
| How do notifications work? | `.cursor/skills/in-app-notifications/SKILL.md` |
| How do feature flags work? | `.cursor/skills/feature-flags/SKILL.md` |
| How does the standup ceremony work? | `.cursor/skills/daily-standup/SKILL.md` |
| How is the changelog updated? | `.cursor/skills/update-changelog/SKILL.md` |
| What are the UI coding standards? | `.cursor/rules/react-coding-standards.mdc`, `.cursor/rules/ui-design-standards.mdc` |
| What are the database conventions? | `.cursor/rules/postgresql-db.mdc` |
| How does RBAC gating work (code)? | `.cursor/rules/rbac-governance.mdc` |
| What nav items exist and who sees them? | `src/shared/types/menuSettings.ts`, `src/client/components/AppHeader.tsx` |
| What views/routes are available? | `src/client/App.tsx` |
| How are AI agents created? | `src/server/services/chatAgentService.ts` |
| How are skills resolved per project? | `src/server/services/projectSettingsService.ts` |
| What AI models are available? | `src/client/config/models.ts`, `src/server/services/modelsService.ts` |
| How does ADO integration work? | `src/server/services/azureDevOps.ts` |
| What are the project settings? | `src/server/services/projectSettingsService.ts`, `src/client/components/AdminProjectSettings.tsx` |
| How do I start a feature interview? | `.cursor/skills/grill-with-docs/SKILL.md` (feature building) or `.cursor/skills/grill-design/SKILL.md` (technical design) |
| How do I generate a PRD from an interview? | `.cursor/skills/to-prd/SKILL.md` — reads `.ai-pilot/kickoff-transcript.md` |
| How do I review/score a PRD? | `.cursor/skills/prd-spec-review/SKILL.md` — deterministic rubric scoring |
| How do I generate design specs from a PRD? | `.cursor/skills/prd-design-spec/SKILL.md` — produces per-Feature design/tech-spec/assumptions |
| How do I review design specs? | `.cursor/skills/design-spec-review/SKILL.md` — quality gate before implementation |
| How do I create test cases from a backlog? | `.cursor/skills/create-test-case/SKILL.md` — QA test suite from `/to-prd` output |
| How does automated design doc validation work? | `.cursor/skills/design-doc-validation/SKILL.md` — auto-scores design docs via `documentValidationService` |

## Agent Guidelines

1. **Read `context.md` first** for a comprehensive product overview before answering any product questions.
2. **Use the feature map** above to locate the relevant source files when you need implementation details.
3. **Check `public/CHANGELOG.json`** for recent changes — it is the canonical record of what shipped and when.
4. **Check `design-docs/`** for architectural context and design decisions behind major features.
5. **Check `.cursor/skills/`** for detailed procedures and rules that AI agents follow for specific workflows.
6. **Do not modify files** unless explicitly instructed — many agents operate in read-only mode.
7. **Respect the scope discipline rule** — do not touch config, environment, or infrastructure files without explicit permission.
