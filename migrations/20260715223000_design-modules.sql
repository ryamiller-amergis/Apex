-- Up Migration

CREATE TABLE design_modules (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  TEXT        UNIQUE NOT NULL,
  label                 TEXT        NOT NULL,
  description           TEXT,
  icon_key              TEXT        NOT NULL DEFAULT 'default',
  source_globs          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  content               TEXT,
  source_fingerprint    TEXT,
  source_commit         TEXT,
  last_generated_at     TIMESTAMPTZ,
  generated_by_model    TEXT,
  sort_order            INTEGER     NOT NULL DEFAULT 0,
  created_by            TEXT,
  updated_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT design_modules_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT design_modules_icon_key CHECK (icon_key IN ('chat', 'interview', 'pdf', 'analysis', 'infra', 'cicd', 'rbac', 'default')),
  CONSTRAINT design_modules_source_globs_array CHECK (jsonb_typeof(source_globs) = 'array')
);

CREATE INDEX idx_design_modules_sort_order ON design_modules (sort_order, label);

INSERT INTO design_modules (
  slug, label, description, icon_key, source_globs, content,
  source_fingerprint, source_commit, sort_order
) VALUES
(
  'chat-home',
  'Chat Home',
  'Agent chat orchestration, durable threads, streaming, and the home experience.',
  'chat',
  '[
    "src/server/services/chatAgentService.ts",
    "src/server/services/chatThreadRepository.ts",
    "src/server/services/pgNotifyService.ts",
    "src/server/routes/chat.ts",
    "src/client/components/AgentHome.tsx",
    "src/client/hooks/useChatThreads.ts",
    "src/client/hooks/useChatStream.ts",
    "src/shared/types/chat.ts"
  ]'::jsonb,
  $chat$
## Purpose

Chat Home provides the primary Apex agent experience. It creates durable chat threads, prepares isolated workspaces, streams agent activity to the browser, and persists messages and run state so a conversation can resume across requests and server processes.

## Architecture

```mermaid
flowchart LR
  AgentHome[Agent Home] --> ThreadHooks[Chat thread hooks]
  ThreadHooks --> ChatRoutes[Chat routes]
  ChatRoutes --> ChatAgent[Chat agent service]
  ChatAgent --> Repository[Chat thread repository]
  ChatAgent --> PgNotify[Postgres notifications]
  PgNotify --> StreamHook[Chat stream hook]
  StreamHook --> AgentHome
```

## Key Files & Layers

| Layer | File | Responsibility |
|---|---|---|
| UI | `src/client/components/AgentHome.tsx` | Hosts thread selection, prompts, and the active agent conversation. |
| Client data | `src/client/hooks/useChatThreads.ts` | Creates, loads, updates, and deletes chat threads. |
| Streaming | `src/client/hooks/useChatStream.ts` | Consumes live run events and updates client state. |
| HTTP | `src/server/routes/chat.ts` | Exposes authenticated chat and streaming endpoints. |
| Orchestration | `src/server/services/chatAgentService.ts` | Creates workspaces, invokes agents, persists run state, and emits events. |
| Persistence | `src/server/services/chatThreadRepository.ts` | Reads and writes durable thread records. |
| Fan-out | `src/server/services/pgNotifyService.ts` | Relays events across server instances through PostgreSQL. |
| Contract | `src/shared/types/chat.ts` | Defines thread, message, kickoff, and SSE event shapes. |

## Data Flow

1. Agent Home uses the thread hooks to create or select a conversation.
2. Chat routes delegate thread and message operations to the chat agent service.
3. The service prepares the workspace, runs the configured agent, and persists messages and run events.
4. PostgreSQL notifications distribute events across instances.
5. The stream hook folds events into the active conversation UI.

## Related Docs

- `context.md` — AI integration and Chat Home product context.
  $chat$,
  'b1a690bce01801077187587992bec0ffedee2f1fab03143b22ca53b61c1a9d04',
  '5f52fc4cb9ec02d6c3049e1db247e1620f395ec1',
  10
),
(
  'interview-workflow',
  'Interview Workflow',
  'Guided discovery, PRD generation, review, and design-document handoff.',
  'interview',
  '[
    "src/server/services/interviewService.ts",
    "src/server/services/prdService.ts",
    "src/server/routes/interviews.ts",
    "src/client/components/InterviewsDashboard.tsx",
    "src/client/components/InterviewChatView.tsx",
    "src/client/components/PrdReviewView.tsx",
    "src/shared/types/interview.ts"
  ]'::jsonb,
  $interview$
## Purpose

The interview workflow turns an AI-guided discovery conversation into reviewable delivery artifacts. It manages interview lifecycle, PRD generation and validation, backlog data, ownership, and the transitions into design work.

## Architecture

```mermaid
flowchart LR
  Dashboard[Interviews dashboard] --> InterviewView[Interview chat view]
  InterviewView --> Routes[Interview routes]
  Routes --> InterviewService[Interview service]
  Routes --> PrdService[PRD service]
  PrdService --> PrdReview[PRD review view]
  PrdReview --> Routes
```

## Key Files & Layers

| Layer | File | Responsibility |
|---|---|---|
| Catalog UI | `src/client/components/InterviewsDashboard.tsx` | Lists interviews and generated artifacts. |
| Interview UI | `src/client/components/InterviewChatView.tsx` | Runs and completes guided interviews. |
| Review UI | `src/client/components/PrdReviewView.tsx` | Presents PRD content, backlog, validation, and approvals. |
| HTTP | `src/server/routes/interviews.ts` | Applies permissions and exposes interview/PRD actions. |
| Interview domain | `src/server/services/interviewService.ts` | Owns interview records and lifecycle transitions. |
| PRD domain | `src/server/services/prdService.ts` | Generates, edits, validates, and reviews PRDs. |
| Contract | `src/shared/types/interview.ts` | Defines interview, PRD, backlog, and validation shapes. |

## Data Flow

1. A user starts an interview from the dashboard and interacts in the interview view.
2. Interview routes persist lifecycle changes through the interview service.
3. PRD generation delegates to the PRD service and records the resulting content and backlog.
4. The review view loads those artifacts and submits validation, revision, and approval actions.
5. Approved artifacts become inputs to later design stages.

## Related Docs

- `design-docs/interview-prd-workflow.md`
- `design-docs/prd-generation-ux.md`
- `design-docs/prd-spec-review.md`
  $interview$,
  'ccf557cc5db6eb6c77086bee9df464cb12fc29e3be0a4a4dddcb54d9f4294fa7',
  '5f52fc4cb9ec02d6c3049e1db247e1620f395ec1',
  20
),
(
  'pdf-assembly',
  'PDF Assembly',
  'Document upload, conversion, page assembly, and PDF export.',
  'pdf',
  '[
    "src/server/services/pdfAssemblyService.ts",
    "src/server/services/pdfConversionJobService.ts",
    "src/server/services/documentConversionService.ts",
    "src/server/workers/pdfExportWorker.ts",
    "src/server/routes/pdf.ts",
    "src/client/components/PdfAssemblyView.tsx",
    "src/shared/types/pdf.ts"
  ]'::jsonb,
  $pdf$
## Purpose

PDF Assembly lets users upload supported documents, convert them into page-level assets, reorder or manipulate those pages, and export a combined PDF. Conversion work is tracked durably so long-running document processing can recover safely.

## Architecture

```mermaid
flowchart LR
  PdfView[PDF assembly view] --> PdfRoutes[PDF routes]
  PdfRoutes --> Assembly[PDF assembly service]
  PdfRoutes --> Jobs[Conversion job service]
  Jobs --> Conversion[Document conversion service]
  Assembly --> Worker[PDF export worker]
  Worker --> Download[Exported PDF]
```

## Key Files & Layers

| Layer | File | Responsibility |
|---|---|---|
| UI | `src/client/components/PdfAssemblyView.tsx` | Uploads files, manages pages, and starts exports. |
| HTTP | `src/server/routes/pdf.ts` | Exposes session, conversion, manipulation, and export endpoints. |
| Assembly | `src/server/services/pdfAssemblyService.ts` | Maintains session manifests and composes output. |
| Job lifecycle | `src/server/services/pdfConversionJobService.ts` | Claims and tracks durable conversion jobs. |
| Conversion | `src/server/services/documentConversionService.ts` | Converts supported source documents. |
| Worker | `src/server/workers/pdfExportWorker.ts` | Performs asynchronous export work. |
| Contract | `src/shared/types/pdf.ts` | Defines sessions, manifests, files, and job statuses. |

## Data Flow

1. The view creates a session and uploads source documents through PDF routes.
2. Conversion jobs track asynchronous document conversion.
3. Converted pages are added to the session manifest and manipulated by the user.
4. Export requests pass the current manifest to the assembly service and worker.
5. The completed PDF is returned for download.

## Related Docs

- `infra/README.md` — deployment considerations for workers and persistent data.
  $pdf$,
  '052665d732acf446db855e93671f7595dd8e999681022a99b275cc755469050d',
  '5f52fc4cb9ec02d6c3049e1db247e1620f395ec1',
  30
),
(
  'backlog-ai-analysis',
  'Backlog AI Analysis',
  'Feature-request intake, AI prioritization, and delivery analytics.',
  'analysis',
  '[
    "src/server/services/featureRequestAnalysisService.ts",
    "src/server/services/featureRequestService.ts",
    "src/server/routes/featureRequests.ts",
    "src/client/components/FeatureRequestsView.tsx",
    "src/client/components/AIAnalysis.tsx"
  ]'::jsonb,
  $analysis$
## Purpose

Backlog AI Analysis combines two analysis surfaces: AI-assisted triage of submitted Apex backlog items and planning analysis over Azure DevOps work. The feature-request path records suggested priority, risk, and rationale while preserving team-owned decisions.

## Architecture

```mermaid
flowchart LR
  RequestsView[Feature requests view] --> Routes[Feature request routes]
  Routes --> RequestService[Feature request service]
  Routes --> AnalysisService[Feature request analysis service]
  AnalysisService --> Agent[Configured analysis agent]
  Agent --> AnalysisService
  AnalysisService --> RequestsView
  PlanningData[Planning work items] --> AIAnalysis[AI Analysis view]
```

## Key Files & Layers

| Layer | File | Responsibility |
|---|---|---|
| Triage UI | `src/client/components/FeatureRequestsView.tsx` | Displays requests, AI recommendations, and team overrides. |
| Planning UI | `src/client/components/AIAnalysis.tsx` | Presents delivery-health analysis for work items. |
| HTTP | `src/server/routes/featureRequests.ts` | Handles submission, review, linking, and re-analysis. |
| Request domain | `src/server/services/featureRequestService.ts` | Persists requests and review updates. |
| AI orchestration | `src/server/services/featureRequestAnalysisService.ts` | Starts the configured skill, watches output, and stores results. |

## Data Flow

1. A request is submitted and stored by the feature request service.
2. The route starts analysis without blocking the submission response.
3. The analysis service invokes the configured skill and watches its output.
4. Priority, risk, and rationale are written back to the request.
5. Reviewers compare AI suggestions with team-owned priority and risk.

## Related Docs

- `design-docs/feature-requests.md`
  $analysis$,
  'faef3bca2f4b3d7960f694969e0692be70f169f66552d172bf9794d70885f6c7',
  '5f52fc4cb9ec02d6c3049e1db247e1620f395ec1',
  40
),
(
  'infrastructure',
  'Infrastructure',
  'Azure resources, runtime data paths, and deployment topology.',
  'infra',
  '[
    "infra/*.tf",
    "infra/README.md",
    "src/server/utils/dataDir.ts",
    "README.md"
  ]'::jsonb,
  $infra$
## Purpose

The infrastructure module describes the Azure resources and runtime conventions used to host Apex. Terraform defines the deployable resource graph, while application utilities choose persistent data locations that work in local and Azure App Service environments.

## Architecture

```mermaid
flowchart LR
  Terraform[Terraform configuration] --> Azure[Azure resources]
  Azure --> App[Apex application]
  App --> Postgres[(PostgreSQL)]
  App --> PersistentData[Persistent data root]
  DataDir[dataDir utility] --> PersistentData
```

## Key Files & Layers

| Layer | File | Responsibility |
|---|---|---|
| Resource graph | `infra/main.tf` | Declares the primary Azure services and wiring. |
| Inputs | `infra/variables.tf` | Defines deployment parameters. |
| Provider | `infra/provider.tf` | Configures Terraform providers. |
| Outputs | `infra/outputs.tf` | Exposes deployed resource values. |
| Operations | `infra/README.md` | Documents provisioning and deployment workflows. |
| Runtime storage | `src/server/utils/dataDir.ts` | Resolves environment-appropriate persistent data paths. |
| Application setup | `README.md` | Documents local development and top-level deployment usage. |

## Data Flow

1. Terraform receives environment inputs and provisions the Azure resource graph.
2. Deployment configuration connects the application to managed services.
3. The server uses PostgreSQL for durable application records.
4. File-backed runtime features resolve their storage root through the shared data directory utility.

## Related Docs

- `infra/README.md`
- `README.md`
  $infra$,
  '4955e5223c2eb0328e6d6577194117ed33dc1905b7b53d743cbd8013786e7711',
  '5f52fc4cb9ec02d6c3049e1db247e1620f395ec1',
  50
),
(
  'ci-cd',
  'CI/CD',
  'Pull-request checks, Azure deployment, and in-app deployment outcomes.',
  'cicd',
  '[
    ".github/workflows/deploy.yml",
    ".github/workflows/pr-tests.yml",
    ".github/workflows/README.md",
    "src/server/services/deploymentTracking.ts",
    "src/server/services/deploymentOutcomeService.ts",
    "src/server/routes/deploymentOutcomes.ts",
    "src/client/components/DeploymentOutcomeReport.tsx",
    "src/shared/types/deploymentOutcome.ts"
  ]'::jsonb,
  $cicd$
## Purpose

CI/CD validates pull requests, deploys approved changes, and records production outcomes in Apex. Workflow automation handles build and deployment execution; the in-app tracking path captures success, failure, downtime, and release metadata for later review.

## Architecture

```mermaid
flowchart LR
  PullRequest[Pull request] --> PrTests[PR test workflow]
  PrTests --> Deploy[Deploy workflow]
  Deploy --> Environment[Azure environment]
  Environment --> Tracking[Deployment tracking]
  Tracking --> OutcomeService[Deployment outcome service]
  OutcomeService --> OutcomeRoutes[Deployment outcome routes]
  OutcomeRoutes --> Report[Deployment outcome report]
```

## Key Files & Layers

| Layer | File | Responsibility |
|---|---|---|
| PR validation | `.github/workflows/pr-tests.yml` | Runs automated checks for pull requests. |
| Deployment | `.github/workflows/deploy.yml` | Builds and deploys the application. |
| Workflow docs | `.github/workflows/README.md` | Explains workflow operation and required setup. |
| Tracking | `src/server/services/deploymentTracking.ts` | Captures deployment lifecycle information. |
| Outcome domain | `src/server/services/deploymentOutcomeService.ts` | Persists and queries deployment outcomes. |
| HTTP | `src/server/routes/deploymentOutcomes.ts` | Exposes deployment outcome operations. |
| UI | `src/client/components/DeploymentOutcomeReport.tsx` | Presents recorded outcomes. |
| Contract | `src/shared/types/deploymentOutcome.ts` | Defines outcome payloads and status data. |

## Data Flow

1. Pull requests run the test workflow before merge.
2. The deployment workflow builds and releases the application.
3. Deployment tracking associates runtime results with release metadata.
4. Outcome routes persist reports through the outcome service.
5. The report component loads and presents release outcomes.

## Related Docs

- `.github/workflows/README.md`
- `infra/README.md`
  $cicd$,
  'b552934587a9d489ba8fd8124ba323b1a5cebb908f9fd3862fa3815ffe9cf6d9',
  '5f52fc4cb9ec02d6c3049e1db247e1620f395ec1',
  60
);

-- Down Migration

DROP TABLE IF EXISTS design_modules;
