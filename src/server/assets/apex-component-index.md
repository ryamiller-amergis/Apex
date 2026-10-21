# APEX Component Index

Components in `src/client/components/`. Use these when generating UI for APEX — reference
them by name and replicate their CSS-variable-based styling patterns.

---

## Admin / Platform

| Component | Route/Context | Purpose |
|-----------|---------------|---------|
| `PlatformAdmin` | `/platform-admin` | Super-admin shell: access, menu visibility, feature flags |
| `AdminRoles` | `/admin` | Manage RBAC roles and permission assignments |
| `AdminUsers` | `/admin` | Manage user access and assignments per project |
| `AdminGroups` | `/admin` | Manage groups for RBAC targeting |
| `AdminNotifications` | `/admin` | Configure notification preferences per project |
| `AdminProjectSettings` | `/admin` | Skill configs, model settings, approver assignments |
| `AdminMenuSettings` | `/admin` | Control which nav items show per project |

## Agent Home & Chat

| Component | Route/Context | Purpose |
|-----------|---------------|---------|
| `AgentHome` | `/home` | Primary AI chat surface: compose, skill pills, thread history |
| `ChatAgentPanel` | Slide-out | Side panel for in-page agent sessions |
| `AskApexChat` | Embedded | Inline Ask-Apex conversational widget |
| `StartChatModal` | Modal | Initiate a new agent chat session |
| `ThreadHistorySidebar` | Sidebar | Past chat thread list and search |
| `AgentActivityTimeline` | Panel | Timeline of agent steps and tool calls |
| `AgentChecklist` | Panel | Live task checklist rendered by the agent |
| `ReadAloudButton` | Inline | Text-to-speech playback for agent messages |

## Backlog & Interviews

| Component | Route/Context | Purpose |
|-----------|---------------|---------|
| `InterviewsDashboard` | `/backlog` | All interviews / PRDs / design docs |
| `InterviewChatView` | `/backlog/*` | AI interview conversation view |
| `BacklogViewer` | `/backlog/*` | Epics → Features → PBI/TBI hierarchy viewer |
| `BacklogDetailsPanel` | Slide-out | Detail panel for a selected backlog item |
| `PrdReviewView` | `/backlog/prd/*` | PRD review and approval view |
| `PrdAssistantPanel` | Panel | Inline PRD assistant chat |
| `PRDPreviewDrawer` | Drawer | Collapsed PRD preview from agent home |

## Design Docs & Prototypes

| Component | Route/Context | Purpose |
|-----------|---------------|---------|
| `DesignDocReviewView` | `/backlog/design-doc/*` | Design document review and approval |
| `DesignPrototypeReviewView` | `/backlog/prototype/*` | Interactive prototype preview and approval |
| `DesignPlanReviewView` | `/backlog/design-plan/*` | Design plan review |
| `DesignModuleView` | `/backlog/module-doc/*` | Module architecture document viewer |
| `DesignModuleFormModal` | Modal | Start or edit a module documentation session |
| `ProposedChangesReview` | Panel | Review AI-proposed edits before applying |
| `ProposedDesignDocChangesReview` | Panel | Design-doc-specific proposed changes |
| `AnnotationLayer` | Overlay | Inline review comment anchors on documents |
| `ReviewCommentSidebar` | Sidebar | Review comment thread management |
| `ReviewerApprovalChecklist` | Panel | Checklist for approvers |
| `ApproverSelectModal` | Modal | Assign approvers to a document |
| `SectionOwnerModal` | Modal | Assign section owners |
| `FixValidationPanel` | Panel | AI validation score and fix suggestions |
| `DiffView` | Inline | Side-by-side diff of document versions |

## ADR (Architecture Decision Records)

| Component | Route/Context | Purpose |
|-----------|---------------|---------|
| `AdrsDashboard` | `/backlog/adrs` | ADR list and status overview |
| `AdrChatView` | `/backlog/adr/*` | ADR interview/assistant chat |
| `AdrAssistantPanel` | Panel | Inline ADR refinement assistant |
| `AdrReviewerModal` | Modal | Assign ADR reviewers |
| `ProposedAdrChangesReview` | Panel | Review staged ADR edits |

## UI Lab

| Component | Route/Context | Purpose |
|-----------|---------------|---------|
| `UiLabView` | `/home` (overlay) | UI Lab prototype generation and editing |
| `UiMockPreview` | Inline | Renders generated HTML prototype in iframe |
| `UiMockSection` | Panel | Single-state section of a prototype |
| `ManipulationToolbar` | Toolbar | Selection and edit tools for prototype editing |
| `BoundaryEditor` | Overlay | Edit a specific region of a prototype |
| `UiSurfacePlanPanel` | Panel | Surface plan (screens list) for a UI Lab session |
| `BlankPageBadge` | Badge | Indicator for new/blank pages in the prototype |
| `DesignTokenInspector` | Panel | View matched design tokens in generated HTML |

## Dev Workbench & My Work

| Component | Route/Context | Purpose |
|-----------|---------------|---------|
| `DevWorkbenchView` | `/my-work` | Dev workbench: session list and management |
| `DevSessionView` | `/my-work/*` | Active development session with AI agent |
| `StartLocalDevModal` | Modal | Start a local dev session |
| `BeginDevKickoffModal` | Modal | Kick off a dev workbench feature session |
| `SourceBrowser` | Panel | File browser within a dev workspace |
| `AssemblyLane` | Panel | PR assembly and merge flow |

## Standup

| Component | Route/Context | Purpose |
|-----------|---------------|---------|
| `StandupCeremonyView` | `/standup` | Active standup ceremony participant view |
| `StandupManageView` | `/standup/manage` | Configure and schedule standup sessions |
| `StandupSummaryView` | `/standup/summary/*` | Standup summary and blocker report |

## Calendar & Work Items

| Component | Route/Context | Purpose |
|-----------|---------------|---------|
| `ScrumCalendar` | `/calendar` | Sprint/release calendar with ADO items |
| `DetailsPanel` | Side panel | Work item detail and edit panel |
| `UnscheduledList` | Sidebar | Unscheduled PBIs awaiting a target date |
| `CalendarWorkItemAssistantPanel` | Panel | AI assistant for calendar work items |
| `CalendarWorkItemChangesReview` | Panel | Review AI-suggested date/field changes |
| `WorkItemCard` | Card | Compact work item summary card |
| `WorkItemDateEditor` | Inline | Inline due-date editor |
| `WorkItemHealthSection` | Section | Health metrics for a work item |

## Planning & Analytics

| Component | Route/Context | Purpose |
|-----------|---------------|---------|
| `PlanningTabs` | `/planning` | Tab navigation across planning views |
| `DevStats` | `/planning/dev-stats` | Developer velocity and PR analytics |
| `DevStatsFilters` | Filter bar | Filters for dev stats views |
| `QAMetrics` | `/planning/qa` | QA bug and test metrics |
| `QABugStatsSection` | Section | Bug count / severity breakdown |
| `AIAnalysis` | `/planning/ai` | AI usage and capability analytics |
| `AiCostAnalytics` | `/ai-cost` | AI cost by model, user, project |
| `AiCostComparison` | Panel | Side-by-side cost comparison |
| `AiCostDrillDown` | Panel | Drill into cost events |
| `AiCapabilityLadderSection` | Section | AI capability baseline and improvement ladder |
| `CycleTimeAnalytics` | Section | Story cycle-time charts |
| `DueDateChangesSection` | Section | History of due-date changes |
| `DueDateHitRateSection` | Section | On-time delivery metrics |
| `PullRequestTimeSection` | Section | PR open-to-merge duration chart |
| `RoadmapView` | `/planning/roadmap` | Roadmap and release timeline |
| `ReleaseView` | `/planning/releases` | Release management and deployment outcomes |
| `EpicProgress` | Section | Epic completion progress bars |

## Cloud Cost

| Component | Route/Context | Purpose |
|-----------|---------------|---------|
| `CloudCost` | `/cloud-cost` | Azure cost by subscription and resource |
| `CloudCostFilters` | Filter bar | Date range and subscription filters |

## Notifications

| Component | Route/Context | Purpose |
|-----------|---------------|---------|
| `NotificationBell` | App header | Unread notification count badge + dropdown |
| `NotificationCenter` | `/notifications` | Full notification history and management |
| `NotificationsPage` | `/notifications` | Notification list page |
| `NotificationPreferences` | Settings | Per-type notification opt-in/out |
| `ToastContainer` | Global | Ephemeral toast message host |

## Feature Requests

| Component | Route/Context | Purpose |
|-----------|---------------|---------|
| `FeatureRequestsView` | `/feature-requests` | Feature request list and triage |
| `FeatureRequestDetailPanel` | Panel | Full detail for a single request |
| `FeatureRequestModal` | Modal | Submit a new feature request |
| `FeatureRequestFab` | FAB | Floating action button to open request modal |

## Shell

| Component | Context | Purpose |
|-----------|---------|---------|
| `AppHeader` | Global | Top navigation bar with project selector and controls |
| `AppSidebar` | Global | Collapsible left nav with feature links |
| `ProjectSelector` | Landing `/` | Project picker before entering a workspace |
| `RepoSelector` | App | Multi-repo skill config switcher |
| `UserMenu` | Header | User profile, theme toggle, sign-out |
| `BrandLogo` | Header | APEX brand mark |
| `Login` | `/login` | Authentication / sign-in screen |
| `ApexLoader` | Loading | Full-screen loading state |
| `ViewSkeleton` | Loading | Per-view skeleton while lazy-loading |
| `ViewErrorFallback` | Error | Error boundary fallback for views |
| `Changelog` | Modal | What's New changelog overlay |
| `ChangelogBanner` | Banner | Top-of-page "new release" banner |
| `MarkdownWithMermaid` | Inline | Renders markdown with Mermaid diagram support |
| `RichTextField` | Form | Rich text input with toolbar |
| `RangeInput` | Form | Numeric range slider |
| `GroupAwarePeoplePicker` | Form | User/group picker with RBAC filtering |
| `ExportPanel` | Panel | Export backlog or document to various formats |
| `ExportSelectedButton` | Button | Trigger export for selected items |
| `ConfirmDeleteModal` | Modal | Confirm destructive deletion |
| `ClarificationBlockerModal` | Modal | Agent asks for clarification before continuing |
| `DeduplicationToast` | Toast | Notify of a deduplicated AI request |
| `UndoSnackbar` | Snackbar | Undo a recent action |
| `ApexFixRunningBanner` | Banner | AI fix-run-in-progress indicator |
| `LinkItemsModal` | Modal | Link work items to a document |
| `CreateAdoItemsModal` | Modal | Push backlog items to Azure DevOps |
| `DeploymentModal` | Modal | Record a deployment outcome |
| `DeploymentOutcomeModal` | Modal | Deployment outcome detail |
| `DeploymentOutcomeReport` | Panel | Deployment outcomes summary |
| `ReleaseFormModal` | Modal | Create or edit a release |
| `DeleteReleaseModal` | Modal | Confirm release deletion |
| `FeatureFlagDemo` | Demo | Feature flag demo component |
| `TeamsNotificationSettings` | Settings | MS Teams notification config |
| `BeginFigmaImportModal` | Modal | Start a Figma design import |
