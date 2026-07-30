# AGENTS.md — Apex Agent Quick Reference

This file is the first-stop reference for AI agents operating within the Apex codebase. For comprehensive product knowledge, read `context.md` at the repo root.

## Application Summary

Apex is an internal product-building and project-management platform. It centralizes AI-guided design interviews, automated PRD/design doc generation, review workflows, daily standups, planning analytics, Azure DevOps integration, feature request triage, cloud cost tracking, guided walkthroughs, load testing, UI prototyping, PDF assembly, AI cost analytics, and design-module scoping into a single React + Express + PostgreSQL application.

## Feature Map

| Feature | Design Docs | Skills | Key Services | Key Components |
|---------|------------|--------|-------------|----------------|
| Agent Home | `design-docs/chat-history-from-home-page.md`, `design-docs/chat-thread-history.md` | — | `chatAgentService.ts`, `chatThreadRepository.ts` | `AgentHome.tsx`, `ThreadHistorySidebar.tsx`, `ChatAgentPanel.tsx` |
| Design Interviews | `design-docs/interview-prd-workflow.md` | `.cursor/skills/kick-off/SKILL.md`, `.cursor/skills/grill-with-docs/SKILL.md`, `.cursor/skills/grill-design/SKILL.md` | `interviewService.ts` | `InterviewChatView.tsx`, `InterviewsDashboard.tsx` |
| Architecture Decision Records | — | `.cursor/skills/adr-interview/SKILL.md`, `.cursor/skills/adr-finalize/SKILL.md`, `.cursor/skills/azure-async-infra/SKILL.md` (messaging/storage/workers), `.cursor/skills/terraform-infra/SKILL.md` (Terraform changes) | `adrService.ts` | `AdrChatView.tsx`, `AdrsDashboard.tsx` |
| PRD Generation & Review | `design-docs/interview-prd-workflow.md`, `design-docs/prd-spec-review.md`, `design-docs/prd-generation-ux.md` | `.cursor/skills/to-prd/SKILL.md`, `.cursor/skills/prd-spec-review/SKILL.md`, `.cursor/skills/create-test-case/SKILL.md` | `prdService.ts`, `chatAgentService.ts` | `PrdReviewView.tsx`, `PrdAssistantPanel.tsx`, `BacklogViewer.tsx` |
| Design Documents | `design-docs/claude-design-prototype.md`, `design-docs/per-feature-design-doc-kickoff.md` | `.cursor/skills/prd-design-spec/SKILL.md`, `.cursor/skills/design-spec-review/SKILL.md`, `.cursor/skills/design-doc-validation/SKILL.md` | `designDocService.ts`, `documentValidationService.ts` | `DesignDocReviewView.tsx`, `DesignPrototypeReviewView.tsx` |
| Design Prototypes | `design-docs/claude-design-prototype.md` | — | `designPrototypeService.ts`, `designSystemService.ts` | `DesignPrototypeReviewView.tsx`, `DesignPlanReviewView.tsx` |
| Daily Standups | `design-docs/standup_ceremony_bot_cf0fc810.plan.md` | `.cursor/skills/daily-standup/SKILL.md` | `standupService.ts`, `standupScheduler.ts` | `StandupCeremonyView.tsx`, `StandupManageView.tsx`, `StandupSummaryView.tsx` |
| In-App Notifications | `design-docs/in-app-notifications.md`, `design-docs/ai-completion-notifications.md` | `.cursor/skills/in-app-notifications/SKILL.md` | `notificationService.ts`, `aiCompletionNotifier.ts` | `NotificationBell.tsx`, `NotificationCenter.tsx`, `ToastContainer.tsx` |
| Feature Flags | `design-docs/feature_flags_system_84747609.plan.md` | `.cursor/skills/feature-flags/SKILL.md` | `featureFlagService.ts` | `PlatformAdmin.tsx`, `FeatureFlagDemo.tsx` |
| Feature Requests | `design-docs/feature-requests.md` | `.cursor/skills/feature-request-analysis/SKILL.md` | `featureRequestService.ts`, `featureRequestAnalysisService.ts` | `FeatureRequestsView.tsx`, `FeatureRequestModal.tsx`, `FeatureRequestFab.tsx` |
| RBAC | `design-docs/rbac.md`, `design-docs/menu-view-rbac.md`, `design-docs/per-user-rbac.md` | `.cursor/skills/rbac-management/SKILL.md` | `rbacService.ts` | `AdminRoles.tsx`, `AdminUsers.tsx` |
| Calendar & Work Items | `design-docs/calendar-work-item-assistant.md` | — | `azureDevOps.ts`, `calendarWorkItemAssistantService.ts` | `ScrumCalendar.tsx`, `UnscheduledList.tsx`, `DetailsPanel.tsx`, `CalendarWorkItemAssistantPanel.tsx` |
| Guided Walkthroughs | — | `.cursor/skills/walkthrough-generation/SKILL.md`, `.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md` | `walkthroughService.ts`, `walkthroughGenerationService.ts`, `walkthroughAiDraftService.ts`, `walkthroughAnchorRegistryService.ts`, `walkthroughAnchorSmartTaggingService.ts`, `walkthroughNotificationService.ts` | `WalkthroughCatalog.tsx`, `WalkthroughRenderer.tsx`, `GuidedWalkthroughHost.tsx`, `WalkthroughHelpPanel.tsx`, `ManualWalkthroughEditor.tsx`, `WalkthroughAnchorManagement.tsx` |
| UI Lab | — | `.cursor/skills/ui-lab/SKILL.md` | `uiLabService.ts` | `UiLabView.tsx` |
| PDF Assembly | `design-docs/pdf-assembly-three-panel-ux.md` | — | `pdfAssemblyService.ts`, `documentConversionService.ts` | `PdfAssemblyView.tsx`, `PdfDocumentSidebar.tsx` |
| AI Cost Analytics | — | — | `aiCostAnalyticsService.ts`, `aiUsageService.ts`, `aiCostScheduler.ts` | `AiCostAnalytics.tsx`, `AiCostComparison.tsx` |
| Design Module | — | `.cursor/skills/design-module-scoping/SKILL.md`, `.cursor/skills/design-module-doc/SKILL.md` | `designModuleScopingService.ts` | `DesignModuleView.tsx`, `DesignModuleFormModal.tsx`, `DesignModuleFileTree.tsx` |
| Load Testing | — | `.cursor/skills/k6-load-test-generation/SKILL.md` | `loadTestService.ts`, `loadTestAiGenerationService.ts` | `LoadTestsListPage.tsx`, `LoadTestDefinitionBuilderView.tsx`, `LoadTestRunDetailView.tsx` |
| Planning & Analytics | — | — | `cursorAnalyticsService.ts` | `DevStats.tsx`, `QAMetrics.tsx`, `AIAnalysis.tsx`, `RoadmapView.tsx`, `ReleaseView.tsx` |
| Cloud Cost | — | — | `azureCost.ts` | `CloudCost.tsx` |
| My Work (Dev Workbench) | `design-docs/my-work-feature-context-viewer.md` | — | `devWorkbenchFeatureContextService.ts`, `localDevContextService.ts` | `DevWorkbenchView.tsx`, `DevSessionView.tsx`, `FeatureContextModal.tsx`, `StartLocalDevModal.tsx` |
| Document Approvals | `design-docs/document-approver-assignments.md`, `design-docs/interview-section-owners.md` | — | `documentApprovalService.ts`, `ownerApprovalService.ts` | `ApproverSelectModal.tsx`, `SectionOwnerModal.tsx` |
| Review Comments | — | — | `reviewCommentService.ts` | `ReviewCommentSidebar.tsx`, `AnnotationLayer.tsx` |
| Changelog | — | `.cursor/skills/update-changelog/SKILL.md` | `appSettingsService.ts` | `Changelog.tsx`, `ChangelogBanner.tsx` |
| Project Settings | `design-docs/project-settings-redesign.md`, `design-docs/project-skill-settings.md` | — | `projectSettingsService.ts` | `AdminProjectSettings.tsx` |
| ADO Export | — | — | `azureDevOps.ts` | `CreateAdoItemsModal.tsx` |
| Ask Apex (this agent) | — | `.cursor/skills/app-knowledge/SKILL.md` | `askApexService.ts` | `AskApexChat.tsx` |
| User Profile | — | — | `profileService.ts`, `avatarResolverService.ts` | `ProfilePage.tsx`, `AvatarEditor.tsx`, `UserMenu.tsx` |

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
| **Platform Admin** | The admin panel for cross-project settings: access management, menu visibility, feature flags, and walkthrough authoring/reporting |
| **Project Admin** | Per-project admin panel for roles, users, groups, project settings, and notifications |
| **Apex (project)** | The virtual project representing the AI-Pilot platform itself; feature request review is scoped to this project |
| **Feature Flag** | A runtime toggle that gates feature access by user, project, or group without redeploying |
| **SSE** | Server-Sent Events — used for real-time notification delivery and chat streaming |
| **Facilitator** | The standup agent that summarizes team updates after all participants submit or the deadline is reached |
| **Walkthrough** | A guided, multi-step in-app tour (modal or coachmark) that teaches users a workflow; authored in Platform Admin and targeted by project, user, or group |
| **Coachmark** | A walkthrough step anchored to an approved+active DB catalog key (resolved at serve time to a `data-testid`) rather than shown as a centered modal |
| **Anchor catalog** | DB registry of walkthrough UI anchors (`walkthrough_anchor_registry`); authoring/runtime allow-list is approved+active rows; DOM markers in `walkthroughAnchors.ts` remain for scanners/opt-in |
| **Smart tags** | AI-suggested classification metadata (tags, route, placements, confidence) applied only to newly discovered pending anchors during sync review |
| **Design Module** | A project-scoped slice of the repository (source globs + docs) used to ground AI agents on a specific area of the codebase |
| **Load Test Definition** | A k6 script and threshold profile stored per project; runs are executed against allowlisted targets with prod-safety guards |

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
├── shared/                  # Shared TypeScript types and walkthrough registries
│   ├── types/               # Type definitions used by both client and server
│   ├── walkthroughRoutes.ts # Curated routes valid for walkthrough steps
│   └── walkthroughAnchors.ts # DOM markers + validation helpers (catalog allow-list is DB)
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
| How should Blob / async workers be designed? | `.cursor/skills/azure-async-infra/SKILL.md`, `infra/shared-async.tf`, `.cursor/rules/azure-async-infra.mdc` |
| How should Apex Terraform be written? | `.cursor/skills/terraform-infra/SKILL.md`, `.cursor/rules/terraform-infra.mdc`, `infra/README.md` |
| What are the project settings? | `src/server/services/projectSettingsService.ts`, `src/client/components/AdminProjectSettings.tsx` |
| How do I start a feature interview? | `.cursor/skills/grill-with-docs/SKILL.md` (feature building) or `.cursor/skills/grill-design/SKILL.md` (technical design) |
| How do I generate a PRD from an interview? | `.cursor/skills/to-prd/SKILL.md` — reads `.ai-pilot/kickoff-transcript.md` |
| How do I review/score a PRD? | `.cursor/skills/prd-spec-review/SKILL.md` — deterministic rubric scoring |
| How do I generate design specs from a PRD? | `.cursor/skills/prd-design-spec/SKILL.md` — produces per-Feature design/tech-spec/assumptions |
| How do I review design specs? | `.cursor/skills/design-spec-review/SKILL.md` — quality gate before implementation |
| How do I create test cases from a backlog? | `.cursor/skills/create-test-case/SKILL.md` — QA test suite from `/to-prd` output |
| How does automated design doc validation work? | `.cursor/skills/design-doc-validation/SKILL.md` — auto-scores design docs via `documentValidationService` |
| How do guided walkthroughs work? | `walkthroughService.ts`, `src/shared/walkthroughRoutes.ts`, Platform Admin → Walkthroughs (catalog + Anchor Management) |
| How are walkthroughs AI-generated? | `.cursor/skills/walkthrough-generation/SKILL.md` via `walkthroughGenerationService.ts` (ranked DB catalog anchors only) |
| How does Anchor Management / sync work? | `walkthroughAnchorRegistryService.ts`, `WalkthroughAnchorManagement.tsx`, Platform Admin → Walkthroughs → Anchor Management |
| How does the calendar work-item assistant work? | `design-docs/calendar-work-item-assistant.md`, `calendarWorkItemAssistantService.ts` |
| How do load tests work? | `loadTestService.ts`, `.cursor/skills/k6-load-test-generation/SKILL.md`, Admin → Load Test Targets |
| What walkthrough routes and anchors exist? | `src/shared/walkthroughRoutes.ts`; anchors: DB catalog via `/api/platform-admin/walkthroughs/anchors` (DOM markers in `walkthroughAnchors.ts`) |
| How is AI usage cost tracked? | `aiCostAnalyticsService.ts`, `aiUsageService.ts`, `/ai-cost` view |

## Agent Guidelines

1. **Read `context.md` first** for a comprehensive product overview before answering any product questions.
2. **Use the feature map** above to locate the relevant source files when you need implementation details.
3. **Check `public/CHANGELOG.json`** for recent changes — it is the canonical record of what shipped and when.
4. **Check `design-docs/`** for architectural context and design decisions behind major features.
5. **Check `.cursor/skills/`** for detailed procedures and rules that AI agents follow for specific workflows.
6. **Do not modify files** unless explicitly instructed — many agents operate in read-only mode.
7. **Respect the scope discipline rule** — do not touch config, environment, or infrastructure files without explicit permission.
