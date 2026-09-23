# Durable Interactive Turns Design

**Status:** Approved
**Date:** 2026-09-23
**Scope:** Task 7 application code and database migration only

## Goal

Make every accepted Home, Interview, and ADR turn durable before execution,
move all enabled-path Cursor/model work out of App Service, split interactive
work into fast and agentic classes, and let saturated work wait in PostgreSQL
without duplicating a user message or falling back to App Service.

The design reuses the Task 3–6 run, attempt, outbox, Blob, orchestrator, actor,
Redis, WebSocket, SSE, and terminal-effect foundations. It does not create or
change Azure resources in Task 7.

## Current behavior being replaced

The current interactive path has four correctness gaps:

- `chatAgentService.ts` prepares a turn, inserts an `agent_runs` row, inserts
  the user message, updates the thread, and posts to the actor in separate
  operations. A failure between them can leave a split turn.
- `interactiveActorAdmissionService.ts` uses one `4 + 12` pool and sheds
  saturation back to App Service. App Service can then run Cursor/model work.
- Actor token frames are mostly ephemeral Redis data. PostgreSQL contains
  milestones and the final message, but not enough offset-addressed token data
  to replay a long interrupted stream.
- Retry resends the previous text as a new turn. That can create a second user
  bubble and can return “Thread not found” even though the failed run and
  original message still exist.

The existing BR-014 rule (“shed over-capacity turns to in-process”) and BR-017
rule (“actor errors use the in-process path”) are explicitly superseded when
`ai-runs-v2-transport` is enabled. They remain true only for the interim legacy
path while the canonical flag is disabled or cannot be evaluated.

## Rollout boundary

`ai-runs-v2-transport` is the only Task 7 rollout flag. Task 7 does not add
another flag.

- If evaluation returns `false`, the current path is unchanged.
- If evaluation throws or cannot return a value, the current path is unchanged.
- If evaluation returns `true`, App Service may validate, upload, classify,
  persist, stream, proxy domain tools, and apply durable artifacts. It must not
  create, resume, send to, or otherwise execute a Cursor agent or model.
- After the canonical flag returns `true`, no later validation, Blob,
  PostgreSQL, dispatch, actor, tool, or model error may cross back into the
  current path.
- `ai-runs-interactive` remains an interim legacy-only switch. It is evaluated
  only inside the current path while `ai-runs-v2-transport` is off or unreadable.
  A later flag-retirement task removes it.

The enabled branch is therefore a one-way boundary: persist and queue, or
return a specific error. It never starts a second execution transport.

The split wraps the exported chat `sendMessage`, not only the HTTP route.
Auto-kickoff and internal Interview/ADR/service callers therefore cross the
same canonical boundary. Browser sends must provide `turnId`; an internal
caller that has no client generates one UUID before durable admission. The
legacy implementation remains private to `chatAgentService.ts`.

## Shared contracts

Task 7 adds `src/shared/types/durableInteractiveTurn.ts`. The contract names
below are fixed for the implementation.

```typescript
export const INTERACTIVE_CLASSES = ['fast', 'agentic'] as const;
export type InteractiveClass = (typeof INTERACTIVE_CLASSES)[number];

export const INTERACTIVE_CAPABILITIES = [
  'plain-chat',
  'workspace',
  'attachments',
  'ado',
  'mcp',
  'tool-heavy',
] as const;
export type InteractiveCapability = (typeof INTERACTIVE_CAPABILITIES)[number];

export type InteractiveDeadlinePolicy = Readonly<{
  absoluteTurnMs: 300_000 | 1_200_000;
  repositoryPreparationMs: null | 300_000;
  firstEventWarmMs: 15_000 | 30_000;
  firstEventColdMs: 30_000;
  toolCallMs: 60_000 | 90_000;
}>;

export type ImmutableInteractiveAttachmentRef = Readonly<{
  attachmentId: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  blobRef: AiRunBlobRef;
  materializedPath: string;
}>;

export type FrozenInteractiveMcpDescriptor =
  | Readonly<{
      kind: 'internal-proxy';
      serverName: 'ado-skills' | 'calendar-assistant' | 'maxview';
      profileId?: string;
      calendarSessionId?: string;
      enableRepoBrowse: boolean;
    }>
  | Readonly<{
      kind: 'external-http-proxy';
      serverName: string;
      url: string;
      headerEnvRefs: Readonly<Record<string, string>>;
    }>;

export type FrozenInteractiveToolGrant = Readonly<{
  userId: string;
  projectId: string;
  allowedOperations: ReadonlyArray<'ado:read' | 'ado:write'>;
  expiresAt: string;
  encryptedAdoToken: null | Readonly<{
    algorithm: 'aes-256-gcm';
    iv: string;
    ciphertext: string;
    authTag: string;
  }>;
}>;

export type DurableInteractiveTurnSpecification = Readonly<{
  schemaVersion: 1;
  kind: 'interactive-turn';
  turnId: string;
  threadId: string;
  userId: string;
  projectId: string;
  interactiveClass: InteractiveClass;
  workflowClass: InteractiveWorkflowClass;
  model: string;
  effort: EffortLevel | null;
  skill: null | Readonly<{
    name: string;
    path: string;
    sha256: string;
    content: string;
  }>;
  currentMessage: Readonly<{
    id: string;
    text: string;
    hidden: boolean;
    attachments: ReadonlyArray<ImmutableInteractiveAttachmentRef>;
  }>;
  transcript: ReadonlyArray<
    Readonly<{
      id: string;
      role: 'user' | 'agent';
      text: string;
      timestamp: string;
    }>
  >;
  grounding: null | Readonly<{
    provider: 'ado' | 'github';
    project: string;
    repository: string;
    sha: string;
    profileId: string;
  }>;
  mcpServers: ReadonlyArray<FrozenInteractiveMcpDescriptor>;
  toolGrant: FrozenInteractiveToolGrant | null;
  currentPrompt: string;
  recreationPrompt: string;
  deadlines: InteractiveDeadlinePolicy;
}>;

export type InteractiveDispatchOutboxPayload = Readonly<{
  schemaVersion: 2;
  kind: 'interactive_dispatch';
  transport: 'dapr-actor-v2';
  runId: string;
  attemptId: string;
  attemptNumber: number;
  dispatchMessageId: string;
  threadId: string;
  userId: string;
  interactiveClass: InteractiveClass;
  workloadLane: InteractiveClass;
  capacityClass: 'interactive';
  deadlineAt: string;
}>;

export type InteractiveTurnAcceptedResponse = Readonly<{
  turnId: string;
  runId: string;
  status: 'queued' | 'dispatched';
  interactiveClass: InteractiveClass;
}>;

export type AgentRunExecutionSnapshot =
  | ExecutionSnapshot
  | DurableInteractiveTurnSpecification;
```

The actor bootstrap adds the current attempt ID, dispatch fence, absolute
deadline, and signed proxy endpoints to the persisted specification. Those
values are facts from the accepted attempt, not worker-selected defaults.
Consumers narrow `AgentRunExecutionSnapshot` with
`kind === 'interactive-turn'`; legacy `ExecutionSnapshot` has no `kind`.

All switches over `InteractiveClass`, `FrozenInteractiveMcpDescriptor.kind`,
interactive API status, transport version, or dispatch destination must have a
`never` check in the default branch.

## Deterministic classification

`src/server/services/interactiveTurnClassifier.ts` owns classification. It
does not inspect prompt prose.

The model registry records the current client model catalog:

- `composer-2`: fast
- `claude-sonnet-4-6`: fast
- `gpt-5.5`: fast
- `gemini-3.1-pro`: fast
- `claude-opus-4-6`: agentic

An unregistered model is agentic.

The skill registry records exact normalized built-in skill markers and their
declared default class and capabilities. A turn with no skill starts from its
model default. A project quick skill is looked up by its server-resolved path;
a path that is not in the registry is agentic. The client cannot submit
classification metadata.

Classification starts with the more expensive of the registered model and
skill defaults. It then applies upgrades:

- `effort: high` upgrades to agentic.
- A turn that requires a materialized or writable repository workspace upgrades
  to agentic. Merely having optional repository metadata does not classify a
  plain-chat turn as workspace-bound.
- Any attachment upgrades to agentic.
- Explicit ADO writes or an ADO-operational skill upgrade to agentic.
- Any internal or external MCP server upgrades to agentic.
- A skill registered as tool-heavy upgrades to agentic.
- Missing or unknown metadata upgrades to agentic.

No effort value, capability, client input, or explicit override can downgrade
an agentic decision. The resulting class is persisted on `agent_runs` and
copied to the outbox payload; the orchestrator never reclassifies it.

## Database and migration

The migration is
`migrations/20260923140000_durable-interactive-turns.sql`.

It makes these additive changes:

- Add `dapr-actor-v2` to `agent_runs.transport_version`.
- Add nullable `requested_by_user_id TEXT`, `interactive_class TEXT`,
  `client_turn_id UUID`, and `client_turn_hash TEXT` columns to `agent_runs`.
- Add nullable `blob_ref JSONB` and `sha256 TEXT` columns to
  `chat_message_attachments`; legacy `path` stays available.
- Add nullable `spec_snapshot JSONB` to `ai_run_attempts`. It is the immutable
  attempt-specific interactive specification; background attempts continue
  using `spec_ref`.
- Add a check allowing only `fast` or `agentic` for
  `agent_runs.interactive_class`.
- Add a check requiring `requested_by_user_id`, `interactive_class`,
  `client_turn_id`, and `client_turn_hash` on every `dapr-actor-v2` row.
- Require every nonnull `client_turn_hash` and attachment `sha256` to be 64
  lowercase hexadecimal characters.
- Add `uq_agent_runs_client_turn` on `(thread_id, client_turn_id)` where the
  turn ID is not null.
- Add `uq_agent_runs_interactive_active_thread` on `thread_id` for
  `lane = 'ai-runs-interactive'` and status in
  `queued`, `dispatched`, or `running`.
- Add `idx_agent_runs_interactive_user_active` on
  `(requested_by_user_id, interactive_class, created_at)` for nonterminal
  interactive runs.
- Add `idx_ai_run_outbox_interactive_due` on
  `((payload->>'interactiveClass'), available_at, created_at)` for unpublished
  `interactive_dispatch` rows.

Existing interactive rows are backfilled with
`interactive_class = 'agentic'` and `requested_by_user_id` from the owning
`chat_threads.user_id` when that thread still exists. Existing rows do not
receive a fabricated client turn ID or request hash. The `dapr-actor-v2`
required-field check applies only to new transport rows.

Before creating the active-thread unique index, the migration checks for more
than one nonterminal interactive run per thread. If any exist, the migration
aborts with the colliding thread IDs; it never chooses a winner or terminalizes
live work.

The down migration first refuses to run while any `dapr-actor-v2` run or
unpublished `interactive_dispatch` row exists. After that precondition passes,
it drops the Task 7 indexes and checks, drops the new columns, and restores the
two-value transport check. It does not rewrite a durable turn into a legacy
transport.

## Immutable attachment handoff

App Service validates attachment count, byte limits, content type, and encoding
before admission. It uploads each accepted attachment to immutable Blob storage
under:

```text
interactive/{threadId}/{turnId}/{attachmentId}/{sha256}
```

The upload uses `If-None-Match: *`. A repeated request with the same turn ID
and bytes reuses the object. Reusing an existing key whose stored metadata does
not match its SHA-256/size is a `TURN_ID_CONFLICT`. Reusing the turn ID with a
different request hash is also `TURN_ID_CONFLICT`; any newly uploaded object
from that rejected request is an accepted orphan.

Text, images, and DOCX inputs supported by the current chat path are supported
by actor materialization. A configured stdio MCP pill is not safe to move
without its executable and secret environment contract, so the enabled path
returns `422 INTERACTIVE_V2_STDIO_MCP_UNSUPPORTED`. Any other unsupported
content type returns `415 INTERACTIVE_V2_ATTACHMENT_UNSUPPORTED`.

Blob upload precedes the PostgreSQL transaction. A failed or rejected
transaction may therefore leave an orphan object. Existing Blob lifecycle
cleanup is the accepted cleanup mechanism; Task 7 adds no Azure lifecycle rule.

## Atomic turn admission

`src/server/services/durableInteractiveTurnRepository.ts` owns both atomic
writes:

```typescript
export type AdmitDurableInteractiveTurnResult =
  | (InteractiveTurnAcceptedResponse & { idempotent: boolean })
  | Readonly<{
      status: 'thread_active';
      activeRunId: string;
    }>
  | Readonly<{
      status: 'user_limit';
      code: 'USER_INTERACTIVE_LIMIT' | 'USER_AGENTIC_LIMIT';
    }>
  | Readonly<{
      status: 'turn_conflict';
    }>;

export interface DurableInteractiveTurnRepository {
  admit(
    input: PreparedDurableInteractiveTurn
  ): Promise<AdmitDurableInteractiveTurnResult>;
  retry(
    input: RetryDurableInteractiveRunInput
  ): Promise<InteractiveTurnAcceptedResponse>;
}
```

Admission uses one PostgreSQL transaction and the database clock:

1. Acquire a transaction-scoped advisory lock for the user and lock the thread.
2. Look up `(thread_id, client_turn_id)` before any limit check.
3. If it exists and `client_turn_hash` matches, return the original run. This
   is a network retry, not another turn.
4. If it exists and the hash differs, return `409 TURN_ID_CONFLICT`.
5. Reject another nonterminal run on the same thread with
   `409 THREAD_ACTIVE_TURN`.
6. Count this user’s nonterminal interactive runs. Two are allowed across
   different threads; a third returns `429 USER_INTERACTIVE_LIMIT`.
7. If the new class is agentic and one agentic run is already nonterminal,
   return `429 USER_AGENTIC_LIMIT`.
8. Insert the user `chat_messages` row. The message ID equals the client
   `turnId`, which makes the visible bubble idempotent.
9. Insert `chat_message_attachments` rows containing immutable Blob refs.
10. Insert the queued `agent_runs` row with transport `dapr-actor-v2`, the
    class, user, client turn ID/hash, absolute `timeout_at`, and the full frozen
    specification in `execution_snapshot`.
11. Insert attempt 1 and its dispatch fence in `ai_run_attempts`.
    Store the same frozen specification in `spec_snapshot`.
12. Insert one `interactive_dispatch` row in `ai_run_outbox`.
13. Insert a durable queued phase event.
14. Set `chat_threads.status = 'running'` and `active_run_id = runId`.
15. Notify the existing outbox channel inside the transaction.

The response is `{turnId, runId, status: 'queued', interactiveClass}`. A
duplicate request may return `dispatched` when the original run has already
advanced.

Global capacity is deliberately absent from admission. Saturation leaves the
run and outbox row queued; only the two per-user limits return 429.

## PostgreSQL-authoritative dispatch

`interactive_dispatch` is an outbox kind, not a Service Bus command. The
existing PostgreSQL `NOTIFY` wakes the orchestrator immediately. The 30-second
outbox safety sweep remains recovery for a missed notification; it is not the
normal polling path.

The orchestrator reads persisted `interactive_class`, current utilization, and
the frozen absolute deadline. It invokes one of two direct Dapr endpoints:

- fast endpoint for `fast`
- agentic endpoint for `agentic`

There is no interactive Service Bus queue or result queue.

Interactive capacity is:

- fast warm floor: 2
- agentic warm floor: 2
- total warm floor: 4
- total active ceiling: 16
- shared burst above the two floors: 12

Each class gets its two-slot floor. Either class may use free shared burst
capacity, including an unused slot from the other class. Queued work in a class
below its floor is selected before additional borrowing by the other class.
Running work is never preempted.

The orchestrator marks the attempt dispatched under its current fence, invokes
the class endpoint, and marks the outbox row published after the endpoint
accepts. If it crashes between those operations, claim expiry replays the same
attempt and fence. The actor treats that replay idempotently. It never creates a
second attempt merely because a direct invocation response was lost.

An outbox row at or beyond `deadlineAt` is terminalized as `hard_timeout`
without actor invocation. A missing endpoint or repeated invocation failure
stays on the durable path and ends in a visible failed run; it cannot invoke
App Service execution.

## Deadlines

The accepted database timestamp starts the absolute deadline, so queue time is
bounded and counts against it.

Fast turns use:

- absolute deadline: 5 minutes
- repository preparation: not allowed; a workspace need upgrades the turn
  to agentic
- first event: 15 seconds with a compatible warm agent, 30 seconds after a
  cold create or resume
- each tool call: 60 seconds

Agentic turns use:

- absolute deadline: 20 minutes, including queue wait, pinned repository
  materialization, attachment materialization, agent creation/resume, tools,
  model output, artifact upload, and terminal persistence
- repository preparation sub-deadline: 5 minutes
- first event: 30 seconds
- each tool call: 90 seconds

App Service freezes these values in the specification and persists the absolute
timestamp in `agent_runs.timeout_at`. The actor receives all values and has no
fallback numbers. Retry sets a fresh absolute timestamp from the same persisted
class and frozen duration policy.

First-event timing starts immediately before `agent.send`. A tool timer starts
on its first tool-call event and ends on that call’s completion/error event.
Absolute and repository timers start earlier and continue to run while child
operations execute.

On deadline or cancellation, the actor aborts cooperatively, cancels the SDK
run, disposes the agent, stops emitting after a fence conflict, and posts one
fenced terminal event. Task 7 adds `hard_timeout`, `tool_timeout`,
`worker_start_failed`, and `validation_failed` to the V2 failure categories.
For `dapr-actor-v2`, the Stop route only persists `cancel_requested` on the
current run/fence; it never searches for an App Service agent. The actor sees
that request in the next fenced ingest response and acknowledges cancellation.

## Actor execution and rehydration

The actor receives only identifiers on the Dapr dispatch call. Through the
authenticated bootstrap route it obtains:

- frozen `DurableInteractiveTurnSpecification`
- attempt ID, number, status, and current dispatch fence
- absolute deadline
- thread’s last persisted Cursor agent ID
- signed internal tool proxy endpoints

Dapr serializes methods for one thread actor. A replay with the same attempt
and fence checks bootstrap status before execution: terminal status returns the
prior outcome without Cursor, while a queued/dispatched/running attempt may
start or resume. An outbox replay queued behind the original invocation
therefore cannot execute the completed turn twice.

It then:

1. If grounding is present, opens the pinned repository by provider, project,
   repository, and SHA.
2. Materializes that pinned repository into an attempt-local directory.
   A fast plain-chat specification has `grounding: null` and receives an empty
   attempt-local workspace instead of paying repository-preparation cost.
3. Downloads and checksum-verifies every attachment Blob, then writes it only
   to its deterministic `materializedPath`.
4. Reuses a compatible warm agent when present.
5. Otherwise resumes the persisted Cursor agent ID.
6. If Cursor reports `agent_not_found`, creates a new agent and sends
   `recreationPrompt`, which contains the bounded durable transcript and the
   current message. It never starts a blank conversation.
7. For a normal resume or warm hit, sends `currentPrompt`.
8. Uploads allowed `.ai-pilot` outputs as immutable attempt artifacts and
   posts their manifest for App Service persistence.
9. Deletes the attempt-local repository and attachments after terminal
   persistence.

The transcript includes visible user and agent messages only. It excludes
hidden prompts, tool payloads, reasoning, terminal error bubbles, and the
current message’s duplicate representation. The current message is carried
separately and appended exactly once by the recreation prompt.

## Signed tool proxy

App-Service-local MCP URLs cannot remain `localhost` when Cursor runs in the
actor. The frozen specification stores logical MCP descriptors, not local URLs
or resolved secrets.

The bootstrap route derives signed proxy endpoints under the already-mounted
`/api/internal/ai-runs` router. The token is HMAC-SHA256 with a domain-separated
key derived from `SESSION_SECRET`; there is no fallback secret. It is bound to:

- run ID
- attempt ID
- dispatch fence
- MCP server name
- absolute expiry

Every proxy request rechecks the signature, expiry, active attempt, and fence.
The proxy may call Apex domain services, ADO, GitHub, MaxView, calendar tools,
or a configured external HTTP MCP using the server-resolved credentials. It
does not invoke Cursor or a model.

For an ADO-write turn, App Service performs the existing permission check
before admission. Any delegated token needed later by the proxy is encrypted
with AES-256-GCM using a second domain-separated key derived from
`SESSION_SECRET`; the frozen grant stores only ciphertext, IV, tag, user,
project, allowed operation, and expiry. The signed run/attempt/fence must match
before App Service decrypts it. Neither the specification returned to the actor
nor logs expose the credential.

Repository reads use the actor’s pinned `RepoReader`, not a proxy back to the
live branch. Configured stdio MCP is rejected before admission as described
above.

## Durable streaming and replay

Redis remains the low-latency path. Its existing short token batches continue
to feed the WebSocket gateway.

In parallel, the actor runs a durable batcher with these fixed limits:

- no more than one PostgreSQL-backed token event per 250 ms per run
- no more than 16 KiB UTF-8 text per event
- each event carries `streamOffset` and `streamEndOffset`
- batches over 16 KiB remain buffered and drain at the same 250 ms cadence
- terminal processing waits for the durable buffer to drain

The final assistant `message` event remains the authoritative complete
snapshot. It is persisted before the terminal `done` event. This keeps each
token row bounded while guaranteeing a refresh receives the complete answer.

Every Redis and PostgreSQL token event carries an event ID and offsets. When
the live and durable boundaries match they reuse the same event ID; when the
low-latency Redis boundary is smaller, the ranges may overlap. Clients
deduplicate on `(eventId, streamOffset)` and merge by offsets, so either case
reconstructs one stream. Legacy token events without an offset retain
append-only behavior.

Replay is paginated in ascending ordinal order with pages of 500. The gateway
and SSE route continue until a page contains fewer than 500 events. They
subscribe before the first page, buffer live events during all pages, then
flush by offset/sequence. A reconnect therefore works for runs with more than
500 durable events.

WebSocket is preferred when `ai-runs-v2-transport` is enabled. After the
existing bounded WebSocket retry threshold, the client reconnects through SSE
using the same last event ID. SSE is only a streaming transport fallback; it
never causes App Service to execute the turn.

## Retry

The route is:

```text
POST /api/chat/threads/:threadId/runs/:runId/retry
```

It uses the same `requireThreadWrite` access check as send. It returns 404 only
when the thread is absent/inaccessible or the run does not belong to that
thread/user-visible conversation.

Retry accepts only a failed `dapr-actor-v2` run with no active attempt. In one
transaction it:

- locks the user, thread, run, and failed latest attempt
- rechecks the per-user limits and one-nonterminal-per-thread rule
- refreshes `agent_runs.timeout_at` from the persisted class policy
- refreshes any delegated tool grant from the authenticated retry request and
  freezes a new attempt-specific specification; message, attachment refs,
  transcript, skill, model, class, and grounding remain unchanged
- creates attempt N+1 with a fresh attempt ID and dispatch fence
- writes a new `interactive_dispatch` outbox row
- sets the existing run and thread active again
- emits a queued phase event

It does not insert a message or upload attachments. The actor reads the new
attempt’s `spec_snapshot`, which retains the original current message and
immutable Blob refs but can carry a fresh encrypted delegated credential.
Repeated retry requests for the same failed attempt return the already-created
active attempt instead of creating another.

`useAgentChatSession` records the failed `runId` from the durable error event.
Home, Interview, and ADR retry buttons call the retry route. No retry button
resends text.

## API errors and labels

Enabled-path send and retry use these stable errors:

- `404 Thread not found` for absent or inaccessible thread/run only
- `409 THREAD_ACTIVE_TURN`
- `409 TURN_ID_CONFLICT`
- `409 RUN_NOT_RETRYABLE`
- `429 USER_INTERACTIVE_LIMIT`
- `429 USER_AGENTIC_LIMIT`
- `415 INTERACTIVE_V2_ATTACHMENT_UNSUPPORTED`
- `422 INTERACTIVE_V2_STDIO_MCP_UNSUPPORTED`
- `422 INTERACTIVE_V2_GROUNDING_UNAVAILABLE`
- `503 INTERACTIVE_V2_TOOL_GRANT_UNAVAILABLE`

The client shows “Queued” after acceptance and “Dispatched” after the durable
dispatch phase event. It does not display or request a queue-position estimate.
The composer remains single-flight within one thread, while the same user may
have one turn active in each of two different threads.

## Failure and recovery invariants

- A committed user message always has one run, one first attempt, one fence,
  and one outbox row.
- A noncommitted turn has none of those PostgreSQL rows.
- Blob orphans are possible; split PostgreSQL turns are not.
- One client turn ID creates at most one user message and run.
- One thread has at most one nonterminal interactive run.
- One user has at most two nonterminal interactive runs and at most one
  agentic run.
- Global saturation queues; it never returns 429.
- A stale attempt cannot write after its fence changes.
- A Redis/WebSocket outage can delay live text but cannot lose the final answer
  or terminal state.
- A retry reuses the original message and attachments.
- Canonical flag-on never executes Cursor/model in App Service.

## Out of scope

Task 7 does not:

- create or update Container Apps
- create queues, topics, subscriptions, Redis, Blob containers, identities,
  role assignments, networking, monitoring, or Terraform
- edit deployment workflows or environment examples
- apply a migration to a deployed database
- retire `ai-runs-interactive`
- remove legacy code needed by canonical flag-off/error behavior
- estimate queue position

Direct endpoint deployment, identity/Blob permissions, environment values,
Azure rollout, canaries, and legacy retirement remain deferred operations.

## Acceptance criteria

- Canonical flag-off and flag-error tests prove the current path still runs.
- Canonical flag-on tests prove the App Service send/retry call graph never
  calls Cursor/model execution.
- A crash at every admission write boundary leaves either zero rows or the
  complete turn.
- Duplicate `turnId` requests return one bubble and one run.
- Per-user limit tests return the exact 429 codes; global saturation stays
  queued.
- Classifier fixtures cover every upgrade and unknown metadata.
- The orchestrator reserves two warm slots per class, borrows to a total of 16,
  and invokes the correct direct endpoint without Service Bus.
- Cold actor tests recreate from the durable transcript after
  `agent_not_found`.
- Deadline tests prove 5-minute and 20-minute absolute bounds, 5-minute repo
  preparation, fast warm/cold first events, and 60/90-second tools.
- Redis interruption followed by replay reconstructs a response with more than
  500 durable events exactly once.
- Home, Interview, and ADR retry tests reuse run/message identity and preserve
  404 behavior.
- Server/client builds, focused unit tests, integration tests, migration up/down
  tests, and `git diff --check` pass.
