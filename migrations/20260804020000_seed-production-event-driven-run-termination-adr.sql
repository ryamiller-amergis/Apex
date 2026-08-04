-- Seed the ADR: "Event-Driven Run Termination" (slug: event-driven-run-termination).
-- Narrow, standalone decision that fixes the interview-turn hang class by making the
-- owner-side per-tool deadline authoritative and retiring heartbeat/progress polling, plus
-- a folded-in companion (item 6) that makes the grounding local->remote fallback bounded,
-- observable, and infrequent. Complementary to (and a prerequisite of) the worker-tier ADR
-- (worker-tier-durable-artifact-handoff, 436850c6-6a98-4cb4-b31e-886ef18c7aec).
-- Owner: Ryan Miller. Reviewer: Aneesh. Mirrors design-docs/event-driven-run-termination-adr.md.

-- Up Migration

INSERT INTO app_users (oid, display_name, email)
VALUES (
  '110b196f-3f0d-4890-969f-5571085039de',
  'Ryan Miller',
  'ryamiller@amergis.com'
)
ON CONFLICT (oid) DO NOTHING;

INSERT INTO app_users (oid, display_name, email)
SELECT
  'c3e8f1a2-5b6d-4e7f-9a0b-1c2d3e4f5a6b',
  'Aneesh',
  'anedunur@amergis.com'
WHERE NOT EXISTS (
  SELECT 1 FROM app_users WHERE lower(email) = lower('anedunur@amergis.com')
);

DO $seed_event_driven_termination_adr$
DECLARE
  v_owner_id TEXT := '110b196f-3f0d-4890-969f-5571085039de';
  v_thread_id UUID := '5e6f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
  v_adr_id UUID := '6f7a1b2c-3d4e-4f5a-9b0c-1d2e3f4a5b6c';
  v_reviewer_id TEXT;
  v_skill_settings_id UUID;
  v_now TIMESTAMPTZ := '2026-08-04T02:10:00.000Z';
BEGIN
  SELECT oid INTO v_reviewer_id
  FROM app_users
  WHERE lower(email) = lower('anedunur@amergis.com')
  ORDER BY last_seen_at DESC NULLS LAST
  LIMIT 1;

  IF v_reviewer_id IS NULL THEN
    RAISE EXCEPTION 'ADR reviewer Aneesh not found in app_users (expected anedunur@amergis.com)';
  END IF;

  SELECT id INTO v_skill_settings_id
  FROM project_skill_settings
  WHERE id = 'df2ab8a5-3a3e-4cbe-b685-1a3e6f0e6d73'
  LIMIT 1;

  INSERT INTO chat_threads (
    id, user_id, status, kickoff, cursor_agent_id, workspace_dir,
    last_error, saved_wiki_url, title, flagged, flagged_at,
    active_run_id, created_at, last_activity_at
  )
  VALUES (
    v_thread_id,
    v_owner_id,
    'closed',
    jsonb_build_object(
      'repo', 'Apex',
      'model', 'claude-opus-4-8',
      'branch', 'main',
      'project', 'Apex',
      'skillPath', '/.cursor/skills/adr-interview/SKILL.md',
      'skillProvider', 'github',
      'skillSettingsId', COALESCE(v_skill_settings_id::text, 'df2ab8a5-3a3e-4cbe-b685-1a3e6f0e6d73')
    ),
    NULL, NULL, NULL, NULL,
    'Adr Interview - Event-Driven Run Termination',
    FALSE, NULL, NULL, v_now, v_now
  )
  ON CONFLICT (id) DO UPDATE
  SET user_id = EXCLUDED.user_id,
      status = EXCLUDED.status,
      kickoff = EXCLUDED.kickoff,
      title = EXCLUDED.title,
      last_activity_at = EXCLUDED.last_activity_at;

  INSERT INTO adrs (
    id, chat_thread_id, adr_assistant_thread_id, author_id, reviewer_ids,
    title, project, repo, model, skill_settings_id, status,
    content, proposed_content, fix_comment_id, slug, created_at, updated_at
  )
  VALUES (
    v_adr_id,
    v_thread_id,
    NULL,
    v_owner_id,
    jsonb_build_array(v_reviewer_id),
    'Event-Driven Run Termination: Replace Heartbeat/Progress Polling with Bounded Tool Deadlines and Terminal Events',
    'Apex',
    'Apex',
    'claude-opus-4-8',
    v_skill_settings_id,
    'proposed',
    $event_driven_adr$
---
adr-number: ADR-pending
status: Proposed
date: 2026-08-03
slug: event-driven-run-termination
---

# Event-Driven Run Termination: Replace Heartbeat/Progress Polling with Bounded Tool Deadlines and Terminal Events

## Status

Proposed

## Context

Apex executes every AI chat turn (interviews, ADRs, Ask Apex, home chat, document
generation/validation) **in-process** on whichever App Service instance accepted the
HTTP/SSE request. The Cursor Agent SDK and its local CLI subprocess — including every
MCP repository tool call (`get_skill_file`, `search_repo_code`, `list_repo_dir`) — run on
that instance, and the run is stamped with `owner_instance`
(`RUN_EVENT_SOURCE_INSTANCE` in `src/server/services/pgNotifyService.ts`).

Liveness and completion are currently inferred by **polling plus a stack of time-based
heuristics**, not asserted by events:

- `src/server/services/agentRunReaperService.ts` runs a `setInterval` reaper every
  `REAP_INTERVAL_MS` (60s). `assessAgentRunHealth` juggles six clocks:
  `heartbeatTimeoutMs` (5m → `worker_lost`), `queuedTimeoutMs` (90s → `never_claimed`),
  `progressStaleMs` (2m → warn), `progressAbortMs` (5m → `progress_timeout`),
  `inFlightToolMaxMs` (6m → abort a `… running` tool), and `hardLimitMs` (2h).
- A per-turn background heartbeat writes `heartbeat_at` / `progress_at` on an interval.
- `src/server/services/startupRecovery.ts` runs a *second* 60s loop
  (`recoverInFlightWork`) that uses `isThreadRunAlive` — itself built on the reaper's
  heartbeat assessment — to decide whether to reset threads stuck in `running`.

We already have substantial defenses against wedged tools, yet they did not prevent a
production hang. `src/server/mcp/mcpTimeout.ts` races every tool handler against
`MCP_TOOL_TIMEOUT_MS` (35s), and `resolveAgentMcpToolTimeoutMs` defines an *owner-side*
deadline (~50s) for a `tool_call` that never emits a terminal SDK event.
`src/server/mcp/mcpRequestLog.ts` deliberately finishes a hung Streamable-HTTP request
with a terminal JSON-RPC result (HTTP 200 + `isError`) rather than destroying the
response, precisely because destroying it leaves the SDK `tool_call` in `running`.

Despite all of that, interview thread `df5def9a` (project Apex) pinned on
`mcp:get_skill_file running` for ~1.2 hours after the user answered "Q13." The server-side
35s handler timeout fired and returned a terminal result, but the **Cursor SDK `tool_call`
stayed `running`** and the owner-side deadline did not force a terminal `agent_runs`
transition. The only thing that eventually killed the run was the reaper's
`heartbeatTimeoutMs`/`inFlightToolMaxMs` **polling** at 5–6 minutes, which emitted
`Worker lost (heartbeat expired)` and cancelled the turn — leaving the user's answer with
no agent reply. The heartbeat kept refreshing while the tool was wedged, so the run *looked*
healthy right up until the poller declared it dead. This is the exact caveat documented in
`.cursor/skills/hung-interview-troubleshoot/SKILL.md`: prefer the tool event's timestamp over
`progress_at`, because heartbeat/progress can keep ticking while an MCP tool is wedged.

The structural problems with the heartbeat/polling model:

- **Liveness is not progress.** A separate heartbeat timer keeps a run "alive" while the
  actual work is wedged, so the health signal lies.
- **Thresholds are unwinnable.** Any global "no progress for N minutes" value is wrong for
  some legitimate operation — too tight kills slow work, too loose is a multi-minute dead
  spinner.
- **Polling adds latency.** The user's dead-spinner time is `tool-wedge + threshold + poll
  interval`, all of it spent *guessing* at something the owner could *know* immediately.
- **It is per-instance.** Runs are pinned to `owner_instance`; only that instance can dispose
  the local CLI, so cross-instance recovery depends on heartbeat expiry.

The environment is a horizontally scaled **App Service `P1v3` with 3 instances**, with no
guarantee that the SSE connection lands on the run's owning instance.

**Scope.** This ADR governs **run termination, liveness, and completion signaling for
in-process agent runs**. It does not move agent execution to a worker tier or change
artifact handoff. It is complementary to — and deliberately narrower than — the
worker-tier ADR (`worker-tier-durable-artifact-handoff`,
`/adr/436850c6-6a98-4cb4-b31e-886ef18c7aec`), whose interactive lane is phase 2. This ADR
makes interactive turns safe in the **current topology now**, and the same bounded-tool
termination is required even after a worker tier exists (moving compute off-box does not make
a wedged `tool_call` return). This ADR also folds in (Decision item 6) the grounding
materialization fallback that routed this turn onto the MCP path in the first place
(`callerGroundingService.ts` / `runGroundingMaterializer.ts`): it makes that fallback
bounded, observable, and infrequent rather than a silent, open-ended hang.

## Decision Drivers

- Terminate a wedged tool/turn **deterministically in seconds**, driven by an event, not by a
  60s poller waking up minutes later.
- Remove heartbeat and meaningful-progress **polling** as the health mechanism; user-visible
  state must be driven by terminal `agent_run_events`.
- Remain correct on a **3-instance App Service** with no ARR-affinity assumption.
- **Reuse the existing spine** — `agent_run_events`, Postgres `LISTEN/NOTIFY`, `replayRunEvents`,
  `raceWithTimeout` / `resolveAgentMcpToolTimeoutMs`, cooperative cancel, and graceful
  shutdown — rather than introduce new subsystems.
- Reduce the irreducible crash-recovery signal to **one coarse absolute deadline per run**,
  not a per-turn heartbeat ticker.
- Make the grounding **local→remote fallback bounded, observable, and infrequent**, so a
  materialization miss degrades gracefully instead of silently routing onto an unbounded MCP
  read.
- Ship behind a **feature flag** with a shadow → enforce → retire path so the old reaper can
  be demoted safely and reversibly.

## Considered Options

### Keep heartbeat/progress polling and only tune the thresholds

Lower `inFlightToolMaxMs` / `heartbeatTimeoutMs` so hung tools are reaped sooner. This is the
smallest change but does not fix the model: it still infers death from stale liveness on a
poll interval, so it either kills legitimately slow operations or leaves a shorter—but still
multi-second-to-minute—dead spinner. It also keeps two competing recovery loops (reaper +
startup recovery) and the per-turn heartbeat writes. Rejected as perpetuating the guessing
game.

### Move execution to a worker tier with a message broker (the worker-tier ADR)

Offload agent execution to Container Apps Jobs / a warm interactive Container App behind
Service Bus, and let the broker's lock/visibility timeout handle liveness. This is the right
long-term isolation story and is adopted separately, but it is materially larger scope
(new compute tier, Service Bus, Blob `ArtifactRef`, admission controller, per-workflow
migration) and its interactive lane is phase 2. Critically, it **still needs per-tool
termination** — relocating compute does not make a stuck `tool_call` emit a terminal event.
Deferred here; this ADR is a prerequisite that also stands alone.

### Rely on an upstream Cursor SDK / MCP transport fix

Wait for the SDK to reliably observe MCP `tool_call` completion so a returned server-side
timeout terminates the tool. This is the true root of the "stuck `running`" symptom, but it
is outside our control and, even fixed, does not address worker/instance death. Rejected as a
sole strategy; pursued in parallel as an upstream report.

### Event-driven run termination in-process (owner-side bounded tool deadlines + terminal events)

Make the owner-side tool deadline **authoritative**: when a `tool_call` exceeds its bound, the
owning instance writes a terminal `agent_run_events` row and force-disposes the SDK agent,
immediately producing a terminal `agent_runs` transition. Completion, failure, and
cancellation all flow through terminal events over the existing `NOTIFY` → SSE spine. The
heartbeat/progress polling heuristics are retired; the only remaining timer is a single coarse
per-run deadline used strictly to reclaim orphans left by a hard crash. Chosen.

## Decision Outcome

Chosen option: **Event-driven run termination in-process**, delivered behind a feature flag
with a shadow → enforce → retire rollout.

**1. Authoritative owner-side tool deadline.** Every SDK `tool_call` is bounded on the owning
instance by `resolveAgentMcpToolTimeoutMs` (already defined). On breach, the owner:
(a) persists a terminal `tool` event (`status: 'failed'`, e.g. `mcp:get_skill_file timeout`)
plus a `done`/`failed` transition via `notifyRunEvent({ persist: true })`; and
(b) force-disposes the agent (`agent[Symbol.asyncDispose]()`), which chatAgentService already
does elsewhere. No heartbeat window, no reaper poll. `McpTimeoutError` is the carrier. On
timeout the turn either surfaces a bounded, actionable failure or retries the read on a
bounded fallback path — never an open-ended spinner.

**2. Completion is a terminal event, not an inference.** `agent_runs` transitions
(`completed | failed | cancelled`) and their `agent_run_events` rows are the single source of
truth for UI state, fanned out by `pg_notify` and caught up on reconnect via
`replayRunEvents`. Client `refetchInterval` polling for run status is removed in favor of the
SSE stream.

**3. Retire the health-polling heuristics.** `assessAgentRunHealth`'s heartbeat, progress-stale,
progress-timeout, and in-flight-tool clocks — and the 60s reaper as the *health* mechanism —
are removed once enforce mode is stable. Per-turn heartbeat/`progress_at` writes used solely
for liveness are dropped. Streamed progress labels remain purely informational.

**4. Multi-instance liveness without heartbeats.** Three distinct failure modes, each handled
without a per-turn heartbeat:

  - **Tool wedged, owner alive (the incident):** the owner-side deadline (item 1) fires locally
    where the `tool_call` lives and emits the terminal event. Inherently multi-instance-safe —
    the instance that owns the wedge is the one that terminates it. No cross-instance
    coordination.
  - **Graceful instance loss (deploy / scale-in):** App Service sends `SIGTERM`, already
    handled by `registerGracefulShutdown` in `startupRecovery.ts`. Extend that handler to
    mark this instance's non-terminal owned `agent_runs` as `failed`/`interrupted` (idempotent
    CAS on `owner_instance` + non-terminal status) and `notifyRunEvent` before exit. This is
    event-driven (triggered by the shutdown lifecycle event) and covers the common
    multi-instance churn with zero reliance on heartbeat expiry.
  - **Hard crash (OOM / SIGKILL, no `SIGTERM`):** the only case an in-process model cannot
    signal from the dead process. Handled by **one coarse absolute `timeout_at` per run**,
    reclaimed lazily when the thread is next accessed and by a low-frequency reconciler. This
    is a single bounded deadline, not a heartbeat ticker, and is the irreducible minimum for
    in-process execution. (A worker tier would relocate this to the broker's visibility
    timeout — still a timeout, just off-box.)

**5. Cross-instance mechanics reuse what exists.** `owner_instance` /
`RUN_EVENT_SOURCE_INSTANCE` identify the owner; cooperative cancel already broadcasts over
`pg_notify` and the owner force-disposes; `replayRunEvents` lets a client that reconnects to a
*different* instance catch up by `ordinal`. No sticky sessions required.

**6. Companion — bounded, observable, minimized grounding fallback.** The grounding path
(`callerGroundingService.start` → `startLocal` → `materialize`) silently falls back to
`remote` when the SHA-pinned checkout of the pinned commit cannot be materialized on the
serving instance — e.g. a freshly-pushed `main` HEAD not yet in the published bundle, or a
multi-instance mirror miss (the exact cause of the incident: the thread activated to the
just-pushed sha `a9b79e6`, `materialize()` returned `unavailable`, and the binding was written
`remote`). Fallback stays supported, but is made safe on three axes:

  - **Bounded (accepted timeout).** In `remote` mode the repo reads execute as MCP
    `tool_call`s, now governed by the owner-side tool deadline (items 1–3). A fallback read
    therefore degrades to a fast, deterministic failure/retry — **this is the residual timeout
    the decision explicitly tolerates** — rather than an open-ended spinner.
  - **Minimized.** Reduce how often fallback happens: (a) prefer grounding to the newest
    *materializable* sha when branch HEAD is not yet in the published bundle, instead of raw
    HEAD; (b) on a pinned-sha miss, attempt a bounded on-demand fetch of that exact commit
    before falling back; (c) materialize **bundle-first from shared Blob** so any of the N
    instances can rehydrate the pinned sha, rather than depending on a per-instance prewarm
    that may live on another instance.
  - **Observable.** Emit the existing `grounding.fallback` / `grounding.materialization.fallback`
    signals as first-class run events and **fix the per-run grounding-telemetry export gap**
    (these events currently do not land in Application Insights), so fallback rate and reason
    (`materialization-unavailable`, `pinned-sha-unavailable`) are watchable during and after
    rollout.

  This keeps `native-read` engaged on the happy path and guarantees the unhappy path is a
  bounded, visible degradation — not a silent multi-minute hang.

**7. Rollout.** Behind a feature flag (e.g. `event-driven-run-termination`):
  - **Shadow:** emit the terminal tool-deadline events alongside the existing reaper; record
    where the event path *would* have terminated versus where the reaper actually did.
  - **Enforce:** terminal events are authoritative; the reaper is demoted to the coarse
    hard-crash `timeout_at` reconciler only.
  - **Retire:** delete the heartbeat/progress polling heuristics, per-turn heartbeat writes,
    and client status polling.
  Advancement is gated on telemetry: tool-timeout terminations, time-to-terminal (owner path
  vs old reaper), orphan-reclaim counts, and zero regressions in cross-instance reconnect
  replay.

## Proposed Architecture

```mermaid
flowchart LR
    User[Web client + SSE] -->|HTTP turn| Web[App Service instance A<br/>run owner]
    User -. reconnect to any instance .-> WebB[App Service instance B<br/>SSE relay]

    subgraph OwnerA[Owning instance A]
        Agent[Cursor Agent SDK + local CLI]
        Deadline[Owner-side tool deadline<br/>resolveAgentMcpToolTimeoutMs]
        Agent -->|tool_call| MCP[MCP repo tools<br/>raceWithTimeout 35s]
        Deadline -->|breach: force-dispose + terminal event| Agent
    end

    Agent -->|tokens / tools / terminal| Events[(agent_run_events<br/>append-only log)]
    Deadline -->|failed transition| Runs[(agent_runs<br/>queued->running->completed|failed|cancelled)]

    Events -->|pg_notify fan-out| Notify[Postgres LISTEN/NOTIFY]
    Notify --> WebB
    Notify --> Web
    Web -->|SSE| User
    WebB -->|SSE + replayRunEvents| User

    SigTerm[SIGTERM on deploy/scale-in] -->|finalize owned non-terminal runs + notify| Runs
    Reconciler[Coarse timeout_at reconciler<br/>hard-crash only] -->|reclaim orphans| Runs

    User -->|cancel| Runs
    Notify -. cooperative cancel .-> Agent
```

## Consequences

### Positive

- A wedged tool or turn terminates **deterministically at its owner-side bound (seconds)**,
  emitting a real `failed` event instead of a 5–6 minute reaper-driven "worker lost" — the
  Q13 dead-spinner class is eliminated.
- Heartbeat and meaningful-progress **polling are removed** as the health mechanism; there is
  no per-turn heartbeat ticker and no threshold-tuning war.
- **Multi-instance correct without sticky sessions:** termination is local to the owner, and
  completion/cancel/replay already fan out across all instances via `agent_run_events` +
  `pg_notify` + `replayRunEvents`.
- **Reuses existing infrastructure** (`mcpTimeout.ts`, the run-event spine, cooperative cancel,
  graceful shutdown) rather than adding subsystems — a small, in-place change.
- **Reversible and low-risk** via the feature-flagged shadow → enforce → retire path; the old
  reaper stays as a fallback until the event path is proven.
- **Complements and de-risks** the worker-tier ADR: it is required there too, and it makes
  interactive interviews safe now rather than waiting for that ADR's phase 2 — directly
  supporting the org-wide rollout.
- **Grounding misses degrade gracefully.** A materialization miss now falls back to a bounded,
  observable remote read instead of a silent hang, and is minimized via materializable-sha
  selection, bounded on-demand exact-sha fetch, and bundle-first shared materialization —
  keeping `native-read` engaged on the happy path (item 6).

### Negative

- **Zero timeouts is not achievable in-process.** A hard crash (OOM/SIGKILL) still requires a
  single coarse `timeout_at` deadline + reconciler to reclaim orphans; heartbeats are removed,
  but this one bounded backstop remains. Fully event-driven liveness for instance death needs
  the worker-tier/broker path.
- **Depends on force-dispose actually returning.** If `agent[Symbol.asyncDispose]()` itself
  hangs on a wedged CLI pipe, we still need a process-level guard; the existing EPIPE guard in
  `registerProcessGuards` mitigates but does not fully cover this. A hard dispose timeout may
  be needed.
- **Graceful-shutdown finalization must be idempotent** and owner-scoped (CAS on
  `owner_instance` + non-terminal status) so a rolling deploy does not fail a run that a new
  instance legitimately continues.
- **The upstream cause persists.** The Cursor SDK `tool_call` remaining `running` after a
  server-side timeout is not fixed by us; we bound its blast radius via owner disposal and
  report it upstream.
- **Two paths during migration.** Shadow/enforce temporarily run the event terminator and the
  reaper together, adding transient observability and code complexity until retire.
- **Residual grounding fallback remains (accepted).** Even minimized, a materialization miss
  still routes to the remote MCP read; the decision accepts this as a bounded, observable
  degradation (item 6), not a hang — but it is a slower path until the materialization
  robustness work (materializable-sha selection, on-demand exact-sha fetch, bundle-first shared
  materialization) fully lands, and it carries the residual timeout called out above.

## References

- `src/server/services/agentRunReaperService.ts` — heartbeat/progress polling heuristics being retired
- `src/server/services/pgNotifyService.ts` — `agent_run_events` + `LISTEN/NOTIFY` spine and `replayRunEvents`
- `src/server/services/startupRecovery.ts` — `recoverInFlightWork`, `registerGracefulShutdown`, `registerProcessGuards`
- `src/server/services/chatAgentService.ts` — in-process run ownership, agent create/dispose, per-turn heartbeat loop
- `src/server/mcp/mcpTimeout.ts` — `raceWithTimeout`, `resolveMcpToolTimeoutMs`, `resolveAgentMcpToolTimeoutMs`, `McpTimeoutError`
- `src/server/mcp/mcpRequestLog.ts` — terminal JSON-RPC result on hung Streamable-HTTP requests
- `src/server/mcp/github/server.ts`, `src/server/mcp/ado/server.ts` — bounded repo tool handlers
- `src/server/services/callerGroundingService.ts`, `src/server/services/runGroundingMaterializer.ts` — companion grounding materialization fallback
- `src/shared/types/chat.ts` — `AgentRunEvent` / `SseHealthEvent` types
- `src/server/services/featureFlagService.ts` — flag evaluation for the rollout gate
- `design-docs/` ADR `worker-tier-durable-artifact-handoff` (`/adr/436850c6-6a98-4cb4-b31e-886ef18c7aec`) — complementary worker-tier decision; this ADR is a prerequisite and remains required there
- `.cursor/skills/hung-interview-troubleshoot/SKILL.md` — failure-mode taxonomy and the heartbeat-vs-tool-event caveat
- `.cursor/skills/azure-async-infra/SKILL.md` — Postgres-first async conventions (broker only on scale triggers)
$event_driven_adr$,
    NULL,
    NULL,
    'event-driven-run-termination',
    v_now,
    v_now
  )
  ON CONFLICT (id) DO UPDATE
  SET chat_thread_id = EXCLUDED.chat_thread_id,
      author_id = EXCLUDED.author_id,
      reviewer_ids = EXCLUDED.reviewer_ids,
      title = EXCLUDED.title,
      project = EXCLUDED.project,
      repo = EXCLUDED.repo,
      model = EXCLUDED.model,
      skill_settings_id = EXCLUDED.skill_settings_id,
      status = EXCLUDED.status,
      content = EXCLUDED.content,
      slug = EXCLUDED.slug,
      updated_at = EXCLUDED.updated_at;

  INSERT INTO document_approver_assignments (
    document_id, document_type, approver_user_id, assigned_by
  )
  VALUES (v_adr_id, 'adr', v_reviewer_id, v_owner_id)
  ON CONFLICT (document_id, document_type, approver_user_id) DO NOTHING;
END
$seed_event_driven_termination_adr$;

-- Down Migration

DELETE FROM document_approver_assignments
WHERE document_id = '6f7a1b2c-3d4e-4f5a-9b0c-1d2e3f4a5b6c' AND document_type = 'adr';

DELETE FROM adrs WHERE id = '6f7a1b2c-3d4e-4f5a-9b0c-1d2e3f4a5b6c';

DELETE FROM chat_threads WHERE id = '5e6f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
