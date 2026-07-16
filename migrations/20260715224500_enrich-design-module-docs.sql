-- Up Migration
-- Refreshes only the six product-owned architecture modules. User-created modules
-- and RBAC assignments are intentionally untouched.

UPDATE design_modules AS dm
SET
  source_globs = seed.source_globs,
  content = seed.content,
  source_fingerprint = NULL,
  source_commit = NULL,
  last_generated_at = NULL,
  generated_by_model = NULL,
  updated_at = now()
FROM (
  VALUES
  (
    'chat-home',
    '[
      "src/client/components/AgentHome.tsx",
      "src/client/hooks/useChatThreads.ts",
      "src/client/hooks/useChatStream.ts",
      "src/server/routes/chat.ts",
      "src/server/services/threadAccessService.ts",
      "src/server/services/chatAgentService.ts",
      "src/server/services/chatThreadRepository.ts",
      "src/server/services/pgNotifyService.ts",
      "src/server/services/agentRunReaperService.ts",
      "src/server/services/startupRecovery.ts",
      "src/server/utils/dataDir.ts",
      "src/server/db/schema.ts",
      "src/shared/types/chat.ts",
      "migrations/20260714100000_durable-agent-run-events.sql"
    ]'::jsonb,
    $chat$
## Purpose and Scope

Chat Home is Apex's durable conversational execution plane. It accepts authenticated prompts, runs a Cursor SDK agent in an isolated workspace, streams progress to one or more browser connections, and preserves thread, message, attachment, run, and event state in PostgreSQL. It also supports late subscribers, cancellation, multi-instance fan-out, restart recovery, and cleanup.

The database is authoritative for conversation and run history. The workspace is execution-local scratch state: kickoff inputs, attachments, and generated outputs can be recreated or synchronized, but must not be treated as the sole durable record.

## System and Component Architecture

```mermaid
flowchart LR
  subgraph Client["Browser boundary"]
    Home["AgentHome"]
    Hooks["Thread and stream hooks"]
  end
  subgraph Api["Authenticated Express API"]
    Routes["Chat routes and thread access"]
  end
  subgraph Runtime["Agent runtime"]
    Chat["chatAgentService"]
    Cursor["Cursor SDK agent"]
    Work["Isolated .ai-pilot workspace"]
  end
  subgraph Data["PostgreSQL boundary"]
    Threads[("chat_threads and chat_messages")]
    Runs[("agent_runs and agent_run_events")]
    Notify["LISTEN and NOTIFY"]
  end
  Home --> Hooks --> Routes --> Chat
  Chat --> Cursor --> Work
  Chat --> Threads
  Chat --> Runs
  Runs --> Notify --> Routes
  Routes --> Hooks
```

## Runtime Sequence and Data Flow

```mermaid
sequenceDiagram
  participant Browser
  participant API as Express chat routes
  participant Chat as chatAgentService
  participant DB as PostgreSQL
  participant Agent as Cursor SDK
  participant WS as Isolated workspace
  Browser->>API: POST threads or messages
  API->>Chat: createThread or sendMessage
  Chat->>WS: write session, kickoff context, attachments
  Chat->>DB: persist thread, message, and running agent_run
  API-->>Browser: 202 accepted
  Chat->>Agent: create or resume with workspace cwd
  Agent-->>Chat: text, tool, phase, and completion events
  Chat->>DB: persist messages and agent_run_events
  Chat->>DB: pg_notify agent_run_events
  DB-->>API: LISTEN fan-out or replay query
  API-->>Browser: SSE event stream and heartbeat
  Chat->>DB: mark run and thread idle or failed
```

## Persistence and State Model

- `chat_threads` stores kickoff configuration, status, Cursor agent ID, workspace path, active run, and errors; `chat_messages` and `chat_message_attachments` store durable history.
- `agent_runs` is the multi-worker run-status source of truth. `agent_run_events` is an ordered immutable replay log; PostgreSQL `NOTIFY` is the low-latency fan-out path.
- Workspaces live under `AI_PILOT_WORKSPACE_DIR`, `/home/data/ai-pilot/workspaces` on Azure, or the OS temp directory locally. Inputs and outputs are under `<workspace>/.ai-pilot/`, including `session.json`, `kickoff-context.md`, `kickoff-transcript.md`, `attachments/<turn-id>/`, and `output/`.

## Key Files and Layers

| Layer | File | Responsibility |
|---|---|---|
| UI | `src/client/components/AgentHome.tsx` | Conversation selection, prompt controls, and rendered activity. |
| Client data | `src/client/hooks/useChatThreads.ts` | Thread HTTP lifecycle and cache updates. |
| Streaming | `src/client/hooks/useChatStream.ts` | SSE consumption, reconnection, and event folding. |
| API and access | `src/server/routes/chat.ts` | Thread CRUD, message acceptance, SSE replay, status polling, and cancellation. |
| Orchestration | `src/server/services/chatAgentService.ts` | Workspace injection, Cursor execution, persistence, event publication, sync, and cleanup. |
| Repository | `src/server/services/chatThreadRepository.ts` | PostgreSQL thread/message persistence and stale interview lookup. |
| Event transport | `src/server/services/pgNotifyService.ts` | Durable event insert, LISTEN/NOTIFY fan-out, deduplication, replay, and reconnect. |
| Recovery | `src/server/services/startupRecovery.ts` | Rehydrates interrupted workflows after process restart. |
| Schema | `src/server/db/schema.ts` | Thread, message, run, and event records. |

## Detailed Runtime Flow

1. The client creates a thread through `/api/chat/threads`; `createThread` creates the workspace, injects kickoff files, and upserts `chat_threads`.
2. A message request is ownership-checked, persisted, acknowledged with HTTP 202, and executed asynchronously.
3. The service creates or resumes the Cursor agent with the workspace as its local working directory and records `agent_runs`.
4. Agent output is converted to SSE events, persisted to `agent_run_events`, published through PostgreSQL, and delivered to local and remote-instance subscribers.
5. A joining browser receives message history plus durable event replay before live subscription, while `/run-status` is the fallback when SSE disconnects.
6. Completion synchronizes recognized output artifacts to domain tables, updates run/thread state, and cleans eligible workspaces.

## Reliability, Failure, and Recovery

- LISTEN connections reconnect after errors; oversized persisted events notify by event ID and are loaded from the table.
- Event IDs are deduplicated, ordered by `ordinal`, and replayed after a cursor event ID.
- The reaper and startup recovery use run heartbeats and durable statuses to reclaim abandoned work; missing interview workspaces are recreated with kickoff files.
- Fatal errors clear resumable agent identity; transient/recoverable SDK failures retain or recreate state according to classification. Cancellation is persisted and broadcast.

## Security and Operational Boundaries

- `/api/chat` is authenticated and requires `chat:view`; thread access middleware enforces read/write ownership or delegated access.
- Attachments are size/count limited and written beneath generated turn paths. The sandbox contains `.ai-pilot` scratch data; repository access is supplied through configured MCP providers.
- API keys and provider credentials remain server-side. PostgreSQL and the shared Azure data root cross process boundaries; in-memory subscribers and live SDK objects do not.

## Related Docs

- `context.md`
- `migrations/20260714100000_durable-agent-run-events.sql`
    $chat$
  ),
  (
    'interview-workflow',
    '[
      "src/client/components/InterviewsDashboard.tsx",
      "src/client/components/InterviewChatView.tsx",
      "src/client/components/PrdReviewView.tsx",
      "src/client/hooks/useInterviews.ts",
      "src/client/hooks/useChatStream.ts",
      "src/server/routes/interviews.ts",
      "src/server/routes/chat.ts",
      "src/server/middleware/rbac.ts",
      "src/server/services/interviewService.ts",
      "src/server/services/prdService.ts",
      "src/server/services/chatAgentService.ts",
      "src/server/services/chatThreadRepository.ts",
      "src/server/services/projectSettingsService.ts",
      "src/server/services/startupRecovery.ts",
      "src/server/db/schema.ts",
      "src/shared/types/interview.ts",
      "src/shared/types/chat.ts",
      "migrations/1778886643190_interview-prd-tables.sql",
      "migrations/20260602070000_interview-section-owners.sql",
      "migrations/20260701214400_add-interview-flow-config.sql",
      "design-docs/interview-prd-workflow.md",
      "design-docs/prd-generation-ux.md",
      "design-docs/prd-spec-review.md"
    ]'::jsonb,
    $interview$
## Purpose and Scope

The Interview Workflow turns a guided discovery conversation into a durable, reviewable PRD and structured backlog. The browser coordinates two related but separate chat threads: an interactive interview thread and a non-interactive `/to-prd` generation thread. Express services persist lifecycle metadata and final artifacts in PostgreSQL while Cursor agents use isolated `.ai-pilot` workspaces for kickoff inputs and generated files.

PostgreSQL is authoritative after synchronization: interview conversation history remains in chat tables, interview metadata in `interviews`, and generated markdown/backlog plus review state in `prds`. Workspace outputs are an asynchronous handoff, not the long-term system of record.

## System and Component Architecture

```mermaid
flowchart LR
  subgraph Client["Browser boundary"]
    Dashboard["InterviewsDashboard"]
    Interview["InterviewChatView"]
    Review["PrdReviewView"]
  end
  subgraph Api["Authenticated Express boundary"]
    ChatRoutes["/api/chat routes"]
    InterviewRoutes["/api/interviews routes and RBAC"]
  end
  subgraph Services["Application services"]
    Chat["chatAgentService"]
    InterviewSvc["interviewService"]
    PrdSvc["prdService and PRD watcher"]
    Config["projectSettingsService"]
  end
  subgraph Agent["Cursor agent boundary"]
    Skills["grill-with-docs and to-prd skills"]
    Workspace[".ai-pilot inputs and outputs"]
    Repo["ADO or GitHub repository through MCP"]
  end
  subgraph Data["PostgreSQL"]
    ChatDb[("chat_threads, chat_messages, agent_runs")]
    DomainDb[("interviews and prds")]
  end
  Dashboard --> Interview
  Interview --> ChatRoutes --> Chat --> Skills
  Interview --> InterviewRoutes --> InterviewSvc --> DomainDb
  Config --> Chat
  Skills --> Repo
  Skills --> Workspace
  Chat --> ChatDb
  Workspace --> PrdSvc --> DomainDb
  Review --> InterviewRoutes
```

## Runtime Sequence and Data Flow

```mermaid
sequenceDiagram
  participant Browser
  participant ChatAPI as Express chat routes
  participant IntAPI as Express interview routes
  participant Chat as chatAgentService
  participant Agent as Cursor agent
  participant WS as .ai-pilot workspace
  participant Watch as prdService watcher
  participant DB as PostgreSQL
  Browser->>ChatAPI: POST thread with interview skill
  ChatAPI->>Chat: createThread with skipAutoKickoff
  Chat->>WS: write session and kickoff context
  Chat->>DB: insert chat_threads
  Browser->>IntAPI: POST interview with chatThreadId
  IntAPI->>DB: insert interviews
  Browser->>ChatAPI: POST first and subsequent answers
  Chat->>Agent: run or resume guided interview
  Agent-->>Browser: durable events over SSE
  Browser->>ChatAPI: POST PRD thread with transcript and to-prd skill
  Chat->>WS: write kickoff-transcript.md
  Chat->>Agent: start non-interactive generation
  Browser->>IntAPI: POST interview PRD record
  IntAPI->>DB: insert prds status generating
  IntAPI->>Watch: poll generated files
  Agent->>WS: write output slug.prd.md and slug.backlog.json
  Watch->>DB: persist content and backlog_json as draft
  Browser->>IntAPI: review, edit, submit, approve, or revise
  IntAPI->>DB: persist PRD workflow state
```

## Persistence and State Model

- `chat_threads`, `chat_messages`, `chat_message_attachments`, `agent_runs`, and `agent_run_events` retain both conversations and execution state.
- `interviews` links one unique interview chat thread and stores author, project/repo, model, owners/approvers, skill settings, and `in_progress`, `complete`, or `archived`.
- `prds` links the interview and generation thread and stores `content`, `backlog_json`, validation/proposed content, reviewer fields, and generation/review statuses.
- Interview kickoff context is written under `<workspace>/.ai-pilot/`; PRD generation receives `.ai-pilot/kickoff-transcript.md`. The `/to-prd` contract writes `.ai-pilot/output/<slug>.prd.md` and `<slug>.backlog.json`.

## Key Files and Layers

| Layer | File | Responsibility |
|---|---|---|
| Interview UI | `src/client/components/InterviewChatView.tsx` | Creates the thread and interview, sends answers, builds transcript, and starts PRD generation. |
| Review UI | `src/client/components/PrdReviewView.tsx` | Reads, edits, validates, and advances persisted PRD artifacts. |
| Client API | `src/client/hooks/useInterviews.ts` | TanStack Query contracts for interview and PRD endpoints. |
| Express API | `src/server/routes/interviews.ts` | RBAC-protected interview, generation, sync, review, and downstream artifact actions. |
| Conversation API | `src/server/routes/chat.ts` | Thread/message/SSE execution used by both agent phases. |
| Domain | `src/server/services/interviewService.ts` | Interview records, ownership, status transitions, and assignment notifications. |
| Artifact lifecycle | `src/server/services/prdService.ts` | PRD records, output watcher, synchronization, review rules, and downstream handoff. |
| Agent runtime | `src/server/services/chatAgentService.ts` | Cursor execution, workspace paths, durable events, post-run sync, and cleanup. |
| Schema | `src/server/db/schema.ts` | Chat, interview, PRD, validation, and relationship definitions. |

## Detailed Runtime Flow

1. `InterviewChatView` first creates a chat thread configured with the selected interview skill, repository/provider, branch, model, and freeform context, with automatic kickoff disabled.
2. The browser posts that thread ID and owner/approver selections to `/api/interviews`; the service inserts `interviews` and sends best-effort assignment notifications.
3. The initial prompt and subsequent answers go through `/api/chat/threads/:id/messages`; Cursor reads repository context through the configured MCP provider and streams persisted events back over SSE.
4. After the author marks the interview complete, the browser serializes visible messages into a transcript and creates a second thread configured for `.cursor/skills/to-prd/SKILL.md`.
5. `/api/interviews/:interviewId/prds` inserts a `prds` row in `generating` state and starts a five-second watcher for both required output files.
6. The watcher or chat post-run synchronizer reads the PRD and backlog, calls `syncPrdContent`, changes status to `draft`, and initiates configured follow-on validation/test-case work.
7. Review routes enforce readiness and ownership/approver rules while storing edits, proposed fixes, validation scorecards, approval state, and design-document handoff in PostgreSQL.

## Reliability, Failure, and Recovery

- The PRD watcher requires both output files, polls for up to 360 attempts, and resets a still-generating PRD to `draft` on timeout.
- Chat completion also performs direct output synchronization, covering watcher timing races; manual `/prds/:prdId/sync` provides an explicit recovery path.
- If an agent exits without PRD output, generation is reset from `generating` to `draft`; successfully synchronized workspaces are cleaned after dependent generation no longer needs them.
- Startup recovery rehydrates durable threads/watchers and clears stale run ownership. Missing sandbox directories are recreated from persisted kickoff data.

## Security and Operational Boundaries

- `/api/chat` and `/api/interviews` are authenticated. Routes require `chat:view`, `interviews:view`, `interviews:manage`, `prds:review`, or downstream permissions as applicable.
- Interview creation additionally requires BA, Manager, or Product-Owner group membership. Services enforce author/owner and assigned-approver rules beyond route RBAC.
- The browser never receives provider credentials. Cursor runs against a scratch workspace and accesses the selected repository through configured ADO/GitHub MCP boundaries.
- Workspace files are temporary and may be deleted; final PRD content/backlog and review state must be read from PostgreSQL.

## Related Docs

- `design-docs/interview-prd-workflow.md`
- `design-docs/prd-generation-ux.md`
- `design-docs/prd-spec-review.md`
    $interview$
  ),
  (
    'pdf-assembly',
    '[
      "src/client/components/PdfAssemblyView.tsx",
      "src/client/components/AssemblyLane.tsx",
      "src/client/components/PageThumbnail.tsx",
      "src/server/routes/pdf.ts",
      "src/server/services/pdfAssemblyService.ts",
      "src/server/services/pdfConversionJobService.ts",
      "src/server/services/documentConversionService.ts",
      "src/server/services/documentConversionWorker.ts",
      "src/server/workers/pdfExportWorker.ts",
      "src/server/utils/dataDir.ts",
      "src/server/db/schema.ts",
      "src/shared/types/pdf.ts",
      "migrations/1782890000000_create-pdf-sessions.sql",
      "migrations/20260711011000_pdf-conversion-jobs.sql",
      "infra/README.md"
    ]'::jsonb,
    $pdf$
## Purpose and Scope

PDF Assembly provides authenticated, per-user temporary document composition. It ingests PDF or DOCX files, stores authoritative session manifests and durable conversion-job state in PostgreSQL, stores source/converted files under the shared data root, and produces ordered/rotated PDFs in a worker thread.

The module is intentionally session-scoped: final exports are streamed to the caller rather than retained as a document repository. Database expiry plus filesystem cleanup bounds retained state.

## System and Component Architecture

```mermaid
flowchart LR
  subgraph Client["Browser"]
    View["PdfAssemblyView and assembly lane"]
  end
  subgraph Api["Authenticated Express and pdf-assembly:use"]
    Routes["PDF routes and Multer"]
  end
  subgraph Services["Server process"]
    Assembly["pdfAssemblyService"]
    Jobs["pdfConversionJobService"]
    Convert["documentConversionService"]
    Export["pdfExportWorker"]
  end
  subgraph State["Durable and temporary state"]
    DB[("pdf_sessions and pdf_conversion_jobs")]
    Files["data root pdf-sessions per session"]
  end
  View --> Routes --> Assembly
  Assembly --> DB
  Assembly --> Files
  Assembly --> Jobs --> DB
  Jobs --> Convert --> Files
  Assembly --> Export --> Routes --> View
```

## Runtime Sequence and Data Flow

```mermaid
sequenceDiagram
  participant Browser
  participant API as PDF routes
  participant Svc as pdfAssemblyService
  participant Jobs as Conversion job processor
  participant Worker as Conversion or export worker
  participant DB as PostgreSQL
  participant FS as Session filesystem
  Browser->>API: create session and upload files
  API->>Svc: validate ownership and ingest
  alt PDF input
    Svc->>FS: store UUID named PDF
    Svc->>DB: append metadata and page manifest
  else DOCX input
    Svc->>FS: move queued DOCX
    Svc->>DB: insert queued conversion job
    API-->>Browser: queued conversion ID
    Jobs->>DB: claim job and heartbeat
    Jobs->>Worker: convert DOCX to PDF
    Worker->>FS: store converted PDF
    Jobs->>DB: complete or fail job
  end
  Browser->>API: update ordered manifest
  Browser->>API: export
  Svc->>Worker: assemble selected pages
  Worker-->>API: PDF bytes
  API-->>Browser: application/pdf response
  API->>FS: cleanup after final response
```

## Persistence and State Model

- `pdf_sessions` stores user ownership, `active`, `exported`, or `expired` status, JSONB page manifest and file metadata, export filename, and four-hour expiry.
- `pdf_conversion_jobs` stores queued input path, `queued`, `processing`, `completed`, or `failed` state, owner instance, heartbeat, timestamps, output file ID, and error details.
- Files live at `PDF_TEMP_DIR` or `<resolveDataRoot()>/pdf-sessions/<session-id>/`; Azure resolves the data root to `/home/data/ai-pilot`.

## Key Files and Layers

| Layer | File | Responsibility |
|---|---|---|
| UI | `src/client/components/PdfAssemblyView.tsx` | Session restore, upload/polling, manifest edits, and export. |
| API | `src/server/routes/pdf.ts` | Authentication, permission, ownership, upload limits, response streaming, and cleanup. |
| Session domain | `src/server/services/pdfAssemblyService.ts` | Validation, limits, manifests, file paths, expiry, conversion integration, and export. |
| Durable jobs | `src/server/services/pdfConversionJobService.ts` | Atomic claims, heartbeats, stale-job recovery, and terminal results. |
| DOCX worker | `src/server/services/documentConversionService.ts` | Serialized worker queue, timeout, one retry after worker error, and shutdown. |
| Export worker | `src/server/workers/pdfExportWorker.ts` | Copies source pages in manifest order and applies rotations. |
| Schema | `src/server/db/schema.ts` | Session and conversion-job state. |

## Detailed Runtime Flow

1. The route creates at most three active sessions per user and creates the per-session directory.
2. Multer writes bounded temporary uploads; service validation sanitizes names, accepts PDF/DOCX only, enforces file/session size and page limits, and verifies PDF magic/parser state.
3. PDFs are renamed to UUID files and atomically reflected in session metadata/manifest. DOCX files are moved to a durable queued path and acknowledged before conversion.
4. One process-local processor claims queued rows conditionally, heartbeats ownership, requeues stale processing rows, and records completion/failure.
5. The client polls the session to observe conversion jobs, then persists ordering, deletion, and rotation through manifest updates.
6. Export resolves every file ID, runs assembly in a production worker thread, streams bytes, marks full exports `exported`, and schedules filesystem cleanup.

## Reliability, Failure, and Recovery

- Processing jobs with stale heartbeats are returned to `queued`; conditional status updates prevent two instances from claiming the same candidate.
- DOCX conversion has a bounded timeout and retries once with a fresh worker after worker failure. Terminal error codes remain queryable.
- Cross-device rename falls back to copy/delete. Missing source files fail export without silently dropping pages.
- Expiry scans remove files and mark sessions expired; final-response cleanup is backed by a short exported-session expiry grace period.

## Security and Operational Boundaries

- Routes require authentication and `pdf-assembly:use`; every session/file/export operation verifies `session.userId`.
- UUID validation and basename sanitization prevent traversal; unsupported, encrypted, corrupt, and oversized inputs are rejected and deleted.
- Source documents and converted files are server-side only. The database stores paths/metadata, while App Service shared storage is required for cross-instance access.
- DOCX conversion and PDF export run outside the request's main JavaScript execution path, but share host CPU and memory limits.

## Related Docs

- `infra/README.md`
- `migrations/20260711011000_pdf-conversion-jobs.sql`
    $pdf$
  ),
  (
    'backlog-ai-analysis',
    '[
      "src/client/components/FeatureRequestsView.tsx",
      "src/client/components/AIAnalysis.tsx",
      "src/client/hooks/useFeatureRequests.ts",
      "src/server/routes/featureRequests.ts",
      "src/server/routes/api.ts",
      "src/server/middleware/rbac.ts",
      "src/server/services/featureRequestService.ts",
      "src/server/services/featureRequestAnalysisService.ts",
      "src/server/services/chatAgentService.ts",
      "src/server/services/projectSettingsService.ts",
      "src/server/services/azureDevOps.ts",
      "src/server/services/notificationService.ts",
      "src/server/db/schema.ts",
      "src/shared/types/featureRequest.ts",
      "src/shared/types/workitem.ts",
      "migrations/1782880009079_feature-requests.sql",
      "migrations/1782880014705_feature-request-skill-settings.sql",
      "migrations/1783973985821_feature-request-interview-link.sql",
      "migrations/1783975306837_feature-request-in-interview-status.sql",
      ".cursor/skills/feature-request-analysis/SKILL.md",
      ".cursor/skills/technical-analysis/SKILL.md",
      ".cursor/skills/issue-analysis/SKILL.md",
      "design-docs/feature-requests.md"
    ]'::jsonb,
    $analysis$
## Purpose and Scope

Backlog AI Analysis contains two source-grounded analysis paths. Feature Request triage stores human submissions and asynchronously asks a configured Cursor skill for priority, risk, and rationale while preserving separate team decisions. The AI Analysis dashboard synchronously queries Azure DevOps for health metrics over `ai-code` tagged work items.

These paths share a user-facing analysis theme but not persistence: feature triage is PostgreSQL-backed; work-item health is computed from Azure DevOps on request.

## System and Component Architecture

```mermaid
flowchart LR
  subgraph Client["Browser"]
    Requests["FeatureRequestsView"]
    Health["AIAnalysis"]
  end
  subgraph Api["Authenticated Express"]
    FrRoutes["Feature request routes and RBAC"]
    ApiRoutes["AI work item health route"]
  end
  subgraph Triage["Async triage"]
    FrSvc["featureRequestService"]
    Analysis["featureRequestAnalysisService"]
    Agent["Cursor agent and configured skill"]
    WS[".ai-pilot output JSON"]
  end
  subgraph Systems["State and external systems"]
    DB[("feature_requests, chat_threads, project_skill_settings")]
    ADO["Azure DevOps Work Item Tracking"]
    Notify["In-app and Teams notifications"]
  end
  Requests --> FrRoutes --> FrSvc --> DB
  FrRoutes --> Analysis --> Agent --> WS --> Analysis
  Analysis --> DB
  FrSvc --> Notify
  Health --> ApiRoutes --> ADO
```

## Runtime Sequence and Data Flow

```mermaid
sequenceDiagram
  participant Browser
  participant API as Feature request routes
  participant Service as Analysis service
  participant DB as PostgreSQL
  participant Agent as Cursor skill agent
  participant WS as Workspace output
  Browser->>API: POST feature, technical, or issue request
  API->>DB: insert request with ai_status pending
  API-->>Browser: 201 created
  API->>Service: fire and forget auto analysis
  Service->>DB: resolve Apex skill settings and create chat thread
  Service->>DB: set analyzing and ai_thread_id
  Service->>Agent: run type-specific skill
  Agent->>WS: write analysis JSON
  Service->>WS: poll every five seconds
  Service->>DB: verify current thread and persist complete result
  Browser->>API: PATCH team priority, risk, rank, or status
  API->>DB: preserve team decision separately
```

## Persistence and State Model

- `feature_requests` stores type, submission, optional interview link, workflow status, AI status/result/thread, team overrides, rank, and reviewer.
- `chat_threads` stores the system-owned analysis thread and workspace path; `project_skill_settings` resolves per-type skill path and model for project `Apex`.
- Output paths are `.ai-pilot/output/feature-request-analysis.json`, `technical-analysis.json`, or `issue-analysis.json`.
- AI work-item health is fetched from Azure DevOps by `AzureDevOpsService`; no local health snapshot is persisted by this route.

## Key Files and Layers

| Layer | File | Responsibility |
|---|---|---|
| Triage UI | `src/client/components/FeatureRequestsView.tsx` | AI suggestions, team overrides, ranking, statuses, and interview handoff. |
| Health UI | `src/client/components/AIAnalysis.tsx` | Date/project filters and Azure DevOps health rendering. |
| API | `src/server/routes/featureRequests.ts` | Submit/view/manage permissions, Apex scoping, notifications, and reanalysis. |
| Analytics API | `src/server/routes/api.ts` | Authenticated `ai-work-item-health` endpoint. |
| Persistence | `src/server/services/featureRequestService.ts` | Request CRUD, interview links, reviewer resolution, and team decisions. |
| Agent adapter | `src/server/services/featureRequestAnalysisService.ts` | Skill/model selection, watcher lifecycle, stale-result rejection, and cleanup. |
| External adapter | `src/server/services/azureDevOps.ts` | Work-item queries and health metric calculation. |
| Schema | `src/server/db/schema.ts` | Feature-request, skill-setting, user, and thread records. |

## Detailed Runtime Flow

1. Submission validates the work-item type and stores `new` plus `pending` before sending reviewer notifications.
2. Fire-and-forget analysis resolves the Apex repository/provider/branch and the type-specific skill/model; missing configuration marks the request `failed`.
3. A system chat thread receives title, description, advantage/focus context and exposes its workspace path through `chat_threads`.
4. The watcher polls the exact JSON output for up to 720 attempts, rejects results from superseded thread IDs, parses priority/risk/rationale, and marks the row `complete`.
5. Reanalysis cancels the current process-local watcher, clears AI fields, creates a replacement thread, and makes stale prior output ineligible.
6. Separately, AI Analysis calls `/api/ai-work-item-health`; Express creates an Azure DevOps service scoped by project/area and returns live aggregate and per-item metrics.

## Reliability, Failure, and Recovery

- Analysis timeout, missing skill configuration, idle agent without output, and JSON parse errors move `ai_status` to `failed`.
- Thread-ID comparison prevents an older reanalysis from overwriting a newer result. Successful stale workspaces are best-effort deleted.
- The watcher registry is process-local; PostgreSQL retains request/thread state, but this service does not show startup watcher rehydration.
- Azure DevOps query failures return HTTP 500 and are not served from stale local cache.

## Security and Operational Boundaries

- Submission, view, and management use distinct RBAC permissions; list access is structurally restricted to project `Apex`.
- Reviewer resolution intersects Apex project assignments with permission holders and super administrators.
- Agent analysis receives only request context and server-resolved skill settings. Team priority/risk remain separate fields and are never overwritten by AI output.
- Azure DevOps credentials/tokens stay in the server adapter boundary; browser requests receive calculated work-item data only.

## Related Docs

- `design-docs/feature-requests.md`
- `.cursor/skills/feature-request-analysis/SKILL.md`
    $analysis$
  ),
  (
    'infrastructure',
    '[
      "infra/main.tf",
      "infra/variables.tf",
      "infra/outputs.tf",
      "infra/provider.tf",
      "infra/README.md",
      "src/server/utils/dataDir.ts",
      "src/server/db.ts",
      "src/server/db/drizzle.ts",
      "src/server/routes/api.ts",
      "README.md"
    ]'::jsonb,
    $infra$
## Purpose and Scope

Infrastructure defines the Azure hosting baseline and the runtime storage conventions consumed by Apex. Terraform provisions Linux App Service, an optional staging slot, PostgreSQL Flexible Server, Application Insights, identities, and supporting resource groups; deployment workflows own mutable runtime settings after provisioning.

The design deliberately separates relational durability from file-backed working data. PostgreSQL is the primary application store. Features that require files use `resolveDataRoot`, which selects an explicit override, Azure's persistent `/home/data/ai-pilot`, or local `<cwd>/data`.

## System and Component Architecture

```mermaid
flowchart LR
  subgraph Edge["Public HTTPS boundary"]
    Users["Browser and Teams clients"]
  end
  subgraph Azure["Azure resource boundary"]
    Plan["Linux App Service Plan"]
    Prod["Production App Service slot"]
    Stage["Optional staging slot"]
    Insights["Application Insights"]
    PG["PostgreSQL Flexible Server 16"]
    Home["Persistent App Service /home data"]
  end
  subgraph External["External service boundaries"]
    ADO["Azure DevOps"]
    Cursor["Cursor API and repository MCP"]
    Bedrock["AWS Bedrock"]
    SendGrid["SendGrid"]
  end
  Users --> Prod
  Plan --> Prod
  Plan --> Stage
  Prod --> PG
  Prod --> Home
  Prod --> Insights
  Prod --> ADO
  Prod --> Cursor
  Prod --> Bedrock
  Prod --> SendGrid
```

## Runtime Sequence and Data Flow

```mermaid
sequenceDiagram
  participant TF as Terraform operator
  participant Azure as Azure Resource Manager
  participant App as Linux App Service
  participant PG as PostgreSQL Flexible Server
  participant Home as Persistent data root
  participant Insights as Application Insights
  TF->>Azure: apply provider, variables, and resource graph
  Azure->>App: create plan, production app, identity, and optional slot
  Azure->>PG: create server, database, backups, and firewall rule
  Azure->>Insights: create telemetry resource
  App->>PG: connect with sslmode require
  App->>Home: resolve and read or write file-backed runtime data
  App->>Insights: emit telemetry with connection string
```

## Persistence and State Model

- PostgreSQL Flexible Server 16 uses 32 GB configured storage, seven-day backup retention, optional high availability, and a database selected by Terraform variables.
- App Service storage is enabled. `resolveDataRoot()` resolves `AI_PILOT_DATA_DIR`, then `/home/data/ai-pilot` on Azure, then `<cwd>/data`.
- Application packages run from package; local deployment contents are replaceable. File-backed state must live under the resolved data root, not the application directory.

## Key Files and Layers

| Layer | File | Responsibility |
|---|---|---|
| Resource graph | `infra/main.tf` | Resource groups, plan, app/slot, PostgreSQL, firewall, identity, settings, logs, and Insights. |
| Inputs | `infra/variables.tf` | Regions, SKUs, worker count, HA, slot, credentials, and integration configuration. |
| Outputs | `infra/outputs.tf` | Deployed app, database, and observability identifiers/endpoints. |
| Provider | `infra/provider.tf` | Terraform and AzureRM provider requirements. |
| Operations | `infra/README.md` | Provisioning, migration, storage, and deployment runbooks. |
| Runtime storage | `src/server/utils/dataDir.ts` | Environment-specific durable data-root selection. |
| Health API | `src/server/routes/api.ts` | Database and agent health endpoints used by operations/deployment. |

## Detailed Runtime Flow

1. Operators supply environment, region, SKU, worker count, HA, staging-slot, and integration variables to Terraform.
2. Terraform creates the App Service plan before the Linux app and optional staging slot, using create-before-destroy for the plan/app.
3. Terraform creates PostgreSQL and its database, exposes an SSL connection string to App Service, and permits Azure-service connectivity through the configured firewall rule.
4. The app starts as Node on Linux, connects to PostgreSQL, and selects persistent file storage through `resolveDataRoot`.
5. Application Insights receives runtime telemetry; App Service also retains bounded filesystem HTTP/error logs.
6. Workflow-managed runtime settings, startup command, affinity, tags, and identity are ignored by Terraform lifecycle rules to avoid deployment drift conflicts.

## Reliability, Failure, and Recovery

- App Service is always-on; worker count and zone balancing are configurable. PostgreSQL HA and standby zone are optional inputs rather than assumed defaults.
- PostgreSQL backups retain seven days. The health endpoint returns 503 when connectivity fails and is used by deployment warmup.
- File persistence depends on App Service storage and the shared `/home/data` location; local temp/application-package paths are not durable.
- `create_before_destroy` reduces replacement interruption, while ignored runtime settings require workflow/operations discipline because Terraform will not repair their drift.

## Security and Operational Boundaries

- The app is HTTPS-only and has a system-assigned identity. Database connections require SSL.
- Azure AD, ADO, Cursor, AWS, SendGrid, and database secrets enter as sensitive Terraform/workflow inputs and server app settings; they are not client assets.
- The PostgreSQL firewall rule allows Azure-origin traffic (`0.0.0.0` convention), so database credentials and TLS remain critical controls.
- App Service and PostgreSQL may be placed in different resource groups/regions through variables; latency and availability choices are operator-controlled.

## Related Docs

- `infra/README.md`
- `README.md`
    $infra$
  ),
  (
    'ci-cd',
    '[
      ".github/workflows/deploy.yml",
      ".github/workflows/pr-tests.yml",
      ".github/workflows/README.md",
      "scripts/ci/has-migration-changes.mjs",
      "scripts/ci/is-markdown-only-changes.mjs",
      "scripts/ci/validate-migrations.mjs",
      "infra/main.tf",
      "infra/variables.tf",
      "infra/README.md",
      "src/server/routes/api.ts",
      "src/server/routes/deploymentOutcomes.ts",
      "src/server/services/deploymentTracking.ts",
      "src/server/services/deploymentOutcomeService.ts",
      "src/server/db/schema.ts",
      "src/client/components/DeploymentOutcomeReport.tsx",
      "src/shared/types/deploymentOutcome.ts",
      "src/server/types/workitem.ts"
    ]'::jsonb,
    $cicd$
## Purpose and Scope

CI/CD validates pull requests, migrates databases when required, packages the Node/React application, deploys PR builds to development, and performs production blue-green deployment with Azure App Service slots. Production traffic moves only after the staging slot passes a database health check; failed post-swap smoke tests trigger an inverse slot swap.

Deployment execution and in-app outcome reporting are separate systems. GitHub Actions/Azure are authoritative for workflow execution. Apex stores operator-reported outcomes in PostgreSQL and also retains legacy deployment metadata in `public/deployments.json`; the workflow does not automatically post those outcome rows.

## System and Component Architecture

```mermaid
flowchart LR
  subgraph GitHub["GitHub Actions boundary"]
    PR["Pull request"]
    Checks["Tests and migration validation"]
    Build["Build and deployment package"]
    ProdFlow["Production deploy workflow"]
  end
  subgraph BlueGreen["Azure App Service blue-green topology"]
    Green["Staging slot with new package"]
    Health["Database health warmup"]
    Router["Slot swap traffic switch"]
    Blue["Production slot with previous package"]
    Smoke["Production smoke check"]
    Rollback["Inverse swap rollback"]
  end
  subgraph Shared["Shared services"]
    DB[("PostgreSQL and pgmigrations")]
    Insights["Application Insights"]
  end
  subgraph Reporting["Apex reporting"]
    OutcomeApi["Deployment outcome API"]
    Outcomes[("deployment_outcomes")]
    Report["DeploymentOutcomeReport"]
    Legacy["public deployments.json"]
  end
  PR --> Checks --> Build --> ProdFlow --> Green
  Green --> Health --> DB
  Health --> Router
  Blue --> Router
  Router --> Smoke
  Smoke -->|failure| Rollback
  Blue --> Insights
  OutcomeApi --> Outcomes --> Report
  Legacy --> Report
```

## Runtime Sequence and Data Flow

```mermaid
sequenceDiagram
  participant GH as GitHub Actions
  participant DB as PostgreSQL
  participant Green as Staging slot
  participant Azure as Azure slot router
  participant Blue as Production slot
  participant Apex as Deployment outcome API
  GH->>GH: npm ci, tests, build, package
  GH->>DB: detect and apply migrations when changed
  GH->>DB: verify no pending migration files
  GH->>Green: configure sticky settings and deploy zip
  loop Up to ten attempts
    GH->>Green: GET /api/health/db
    Green->>DB: SELECT NOW
  end
  GH->>Azure: swap staging to production
  Azure->>Blue: route production traffic to new package
  loop Up to five attempts
    GH->>Blue: GET /api/health/db
  end
  alt smoke check fails
    GH->>Azure: swap production back to staging
  else smoke check succeeds
    GH-->>GH: deployment succeeds
  end
  Apex->>DB: optionally record success, downtime, or rollback
```

## Deployment State and Topology

```mermaid
stateDiagram-v2
  [*] --> Validate
  Validate --> Migrate: migration changes detected
  Validate --> DeployGreen: no migration changes
  Migrate --> DeployGreen: no pending migrations
  DeployGreen --> CheckGreen
  CheckGreen --> Failed: health retries exhausted
  CheckGreen --> Swap: HTTP 200
  Swap --> CheckBlue
  CheckBlue --> Complete: HTTP 200
  CheckBlue --> Rollback: smoke retries exhausted
  Rollback --> Failed
```

## Persistence and State Model

- `pgmigrations` is checked against repository `migrations/*.sql`; production deployment fails if pending migrations remain after apply.
- `deployment_outcomes` stores deployment ID, release version, environment, `success`, `downtime`, or `rollback`, downtime, details, reporter, and deployment/report timestamps.
- `public/deployments.json` is used by `DeploymentTrackingService` for release/environment/work-item metadata and version renames. It is file-backed and distinct from workflow state.
- App Service production and staging slots share the managed service topology while slot-sticky redirect/Insights settings remain with their slot.

## Key Files and Layers

| Layer | File | Responsibility |
|---|---|---|
| PR pipeline | `.github/workflows/pr-tests.yml` | Change detection, test suite, migration validation, and development deployment. |
| Production pipeline | `.github/workflows/deploy.yml` | Build, migrations, package, staging deployment, health gates, swap, smoke, and rollback. |
| Migration gates | `scripts/ci/validate-migrations.mjs` | Applies/rolls back migration sequences against PostgreSQL in CI. |
| Slot topology | `infra/main.tf` | Production web app and optional staging slot on one App Service plan. |
| Health API | `src/server/routes/api.ts` | Unauthenticated database connectivity endpoint used for warmup/smoke checks. |
| Outcome API | `src/server/routes/deploymentOutcomes.ts` | Authenticated CRUD, filters, summaries, and export. |
| Outcome persistence | `src/server/services/deploymentOutcomeService.ts` | PostgreSQL outcome records and aggregation. |
| Legacy tracking | `src/server/services/deploymentTracking.ts` | File-backed deployment metadata and version rename rollback. |
| UI | `src/client/components/DeploymentOutcomeReport.tsx` | Outcome filters, table/report, and export. |

## Detailed Runtime Flow

1. Pull requests detect migration and markdown-only changes. Non-doc changes run the full tests; migration changes are validated against PostgreSQL 16 before development deployment.
2. Main-branch production runs are serialized by `prod-deploy`, run tests/build, detect and apply migrations, and explicitly compare migration files with `pgmigrations`.
3. The workflow packages built output plus production dependencies, authenticates to Azure with a service principal, and configures the staging slot.
4. The package is deployed only to staging. The workflow waits 30 seconds and requires `/api/health/db` HTTP 200 within ten attempts before the protected production-swap job can run.
5. Azure swaps staging into production. After stabilization, five production health attempts verify the traffic target.
6. A failed production smoke check swaps production back toward staging, restoring the pre-swap package. Azure logout runs regardless of outcome.
7. Separately, authenticated users can record and report deployment outcomes; summaries aggregate success, downtime, rollback, and monthly counts.

## Reliability, Failure, and Recovery

- Production deployments cannot overlap and are not cancelled in progress. Environment protection can gate staging and production-swap jobs.
- Migration application precedes code swap; schema rollback is not part of slot rollback, so migrations must remain compatible with both slot versions during the swap window.
- Staging failure prevents any traffic swap. Post-swap failure invokes explicit inverse swap, but the workflow does not show a second health verification after rollback.
- Health checks verify database connectivity and application startup, not full business transactions. Application Insights and App Service logs are the operational diagnostic paths.
- Outcome reporting is not automatically coupled to the workflow and can diverge from GitHub/Azure history; legacy JSON is also vulnerable to package/filesystem replacement.

## Security and Operational Boundaries

- GitHub environments and encrypted secrets hold Azure service-principal, database, ADO, Cursor, AWS, SendGrid, and telemetry credentials.
- `/api/health/db` is intentionally unauthenticated for Azure warmup and external monitoring and reveals only health/timestamp or a generic failure.
- Deployment outcome routes are authenticated by the server mount, but the route file does not add a deployment-specific RBAC permission.
- Sticky redirect and telemetry settings prevent slot swap from carrying environment-specific values to the wrong slot.

## Related Docs

- `.github/workflows/README.md`
- `infra/README.md`
    $cicd$
  )
) AS seed(slug, source_globs, content)
WHERE dm.slug = seed.slug;

-- Down Migration
-- Do not overwrite documentation that may have been regenerated or edited after
-- this migration. Invalidating fingerprints is safe and causes a fresh source
-- comparison without deleting module content.

UPDATE design_modules
SET
  source_fingerprint = NULL,
  source_commit = NULL,
  updated_at = now()
WHERE slug IN (
  'chat-home',
  'interview-workflow',
  'pdf-assembly',
  'backlog-ai-analysis',
  'infrastructure',
  'ci-cd'
);
