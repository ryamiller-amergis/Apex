-- Corrective, forward-only migration for Phase 2 (WebSocket gateway + Dapr virtual actors on ACA).
--
-- Fixes the half-applied 20260806220000 run: apply-named-migration.js executes the WHOLE file
-- (both Up and Down), and the prior file's \n-based regexp strips did not match prod content that
-- the original seed (20260805150000) stored with Windows CRLF line endings. Result in prod: the
-- Phase 2 backlog epic was removed and the old design docs deleted, but the new design doc, the
-- new PRD Phase 2 markdown, and the new ADR addendum were not landed, and the old ADR interactive
-- addendum + old PRD Phase 2 markdown remained.
--
-- This migration is FORWARD-ONLY and idempotent:
--   * CRLF-tolerant strips remove any prior Phase 2 markdown / ADR addendum (old or new);
--   * robust JSONB filter-then-append lands the single FEAT-007 epic, BR-013..019, and phase 4;
--   * the new FEAT-007 design doc (feature_index 6) is inserted (ON CONFLICT updates);
--   * the DOWN section is intentionally a NO-OP so apply-named-migration.js cannot revert it.
--
-- Target PRD 45f17f84-bdb9-437e-bb6e-9c10ff5a2b37; companion ADR 436850c6-6a98-4cb4-b31e-886ef18c7aec.
-- Author: Ryan Miller (110b196f-3f0d-4890-969f-5571085039de). Reviewer/approver: Aneesh (1ceaafde-4871-4411-9ef7-5432c7b4e080).

-- Up Migration

UPDATE prds
SET backlog_json = jsonb_set(
      jsonb_set(
        jsonb_set(
          backlog_json,
          '{epics}',
          (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
             FROM jsonb_array_elements(backlog_json->'epics') e
            WHERE e->>'title' <> 'Real-Time Interactive Agent Worker Tier (Phase 2)')
          || $epic$
[
  {
    "title": "Real-Time Interactive Agent Worker Tier (Phase 2)",
    "priority": "Must Have",
    "description": "Provide a warm, low-latency interactive transport so interactive chat agents (Interview, ADR, Agent Home chat, Ask Apex, and the calendar/PRD/design assistants) execute off the web tier and stream near-real-time tokens back to users over a WebSocket agent gateway, isolated from and fairly co-scheduled with the bounded background lane. Interactive turns are dispatched in-cluster to warm Dapr virtual actors (one per chat thread) on Azure Container Apps managed Dapr — never through Service Bus — while background generation continues to use the existing ai-runs-background Service Bus lane unchanged. Durable token/terminal events keep flowing through the existing PostgreSQL notification log for reconnect-safe ordinal replay; a low-latency Dapr pub/sub (Redis) backplane carries live fan-out to the socket-holding gateway.",
    "dependencies": [
      "Background Worker Execution",
      "Controlled Background Workflow Migration"
    ],
    "outOfScope": [
      "Model selection and skill authoring.",
      "Adding a Service Bus queue for interactive turns (interactive dispatch is in-cluster; Service Bus stays background-only).",
      "Guaranteeing an absolute latency independent of the shared Cursor upstream concurrency and rate quota.",
      "A dedicated interactive queue page or exact queue-position UI.",
      "A new human RBAC permission."
    ],
    "assumptions": [
      "The Phase 1 lifecycle, admission governor, fenced ingest, reaper, durable fan-out (agent_run_events/replayRunEvents), and shared Cursor execution core (FEAT-001..006) are deployed and stable and can be reused for the interactive lane.",
      "Azure Container Apps managed Dapr provides virtual actors (single activation per actor id, turn-based concurrency) and pub/sub suitable for a per-conversation session model.",
      "A warm actor app with a non-zero min-replica floor plus concurrency burst keeps interactive first-token latency low under concurrent background load.",
      "The existing SSE consumer (useChatStream) can be migrated to a WebSocket client while preserving ordinal dedup and reconnect replay.",
      "The Cursor upstream quota is shared across hosts, so the interactive lane improves isolation and latency but does not raise the account's ceiling."
    ],
    "successMetrics": [
      "Interactive first-token latency P95 stays within the configured SLO while at least 40 background runs execute concurrently.",
      "No interactive turn is starved by background admission: reserved warm actor capacity is never consumed by the background lane.",
      "No interactive turn is dispatched through Service Bus; the interactive path is entirely in-cluster.",
      "Disabling ai-runs-interactive routes all new interactive turns in-process while already-active interactive turns drain."
    ],
    "features": [
      {
        "id": "FEAT-007",
        "title": "Real-Time Interactive Agent Transport (WebSocket Gateway + Dapr Virtual Actors on ACA)",
        "priority": "Must Have",
        "route": "Existing chat surfaces",
        "dependsOn": [
          "FEAT-003",
          "FEAT-004",
          "FEAT-006"
        ],
        "description": "Move interactive chat agents onto a WebSocket agent gateway backed by warm Dapr virtual actors (one per chat thread) on Azure Container Apps. Interactive turns are dispatched in-cluster (never through Service Bus), run the shared Cursor execution core with Agent.resume over a warm grounded checkout, and stream batched tokens back over the WebSocket while every event persists to agent_run_events for reconnect-safe ordinal replay. Admission reserves warm actor capacity the background lane can never consume and sheds over-capacity turns immediately to the in-process path. Rollout is gated by a default-off ai-runs-interactive Feature Flag with fail-closed fallback, drain-on-disable, and a first-token latency SLO with alerting.",
        "featureFlag": {
          "name": "ai-runs-interactive"
        },
        "userTypes": [
          "Developer",
          "Product-Owner",
          "BA",
          "Manager",
          "Platform Admin"
        ],
        "affectedPersonas": [
          "Developer",
          "Product-Owner",
          "BA",
          "Manager",
          "Platform Admin"
        ],
        "outOfScope": [
          "Any Service Bus on the interactive path (the ai-runs-background lane is retained unchanged).",
          "A new client transport beyond migrating the existing chat stream to WebSocket.",
          "A hard per-project interactive cap in Phase 2."
        ],
        "personaBehaviors": [
          {
            "behavior": "Builds the WebSocket agent gateway and the Dapr virtual-actor session host on ACA (single activation per thread, turn-based ordering, Agent.resume + warm checkout, batched streaming, cooperative cancel, fence abort); extends admission to reserve warm actor capacity with immediate shed; migrates the client transport to WebSocket while reusing the durable pg NOTIFY + agent_run_events replay spine.",
            "userTypes": [
              "Developer"
            ]
          },
          {
            "behavior": "Experience near-real-time back-and-forth with any Apex chat agent that stays responsive even while dozens of background design docs generate; no perceived change to how they chat.",
            "userTypes": [
              "Product-Owner",
              "BA",
              "Manager"
            ]
          },
          {
            "behavior": "Controls the interactive rollout and kill switch and reads first-token/turn latency, lane utilization, and warm-actor health to tune reserved capacity.",
            "userTypes": [
              "Platform Admin"
            ]
          }
        ],
        "items": [
          {
            "id": "TBI-009",
            "type": "TBI",
            "title": "Provision the interactive actor host and WebSocket gateway on ACA with managed Dapr, warm floor, backplane, and identity",
            "priority": "Must Have",
            "dependsOn": [],
            "parallelGroup": "interactive-infra",
            "description": "Provision an Azure Container Apps app for the interactive actor host and a stateless WebSocket gateway with managed Dapr, a non-zero warm min-replica floor plus concurrency burst, a Dapr pub/sub + actor state store backplane (Azure Cache for Redis), the interactive runner managed identity, Key Vault CURSOR_API_KEY access, image pull, the AiRun.Runner role, and the shared Azure Files mount. No ai-runs-interactive Service Bus queue is created; the background lane is unchanged.",
            "definitionOfDone": [
              "An ACA app runs the actor host and gateway with managed Dapr enabled and WebSocket ingress.",
              "The app holds a reserved warm min-replica floor and bursts on concurrency without scaling to zero.",
              "A Redis-class Dapr pub/sub + actor state store component is provisioned and reachable in-cluster.",
              "The interactive runner identity can read CURSOR_API_KEY from Key Vault, pull its image, and mount the workspace; no Service Bus interactive queue exists."
            ],
            "technicalDependencies": [
              "Phase 1 secure worker infrastructure (FEAT-003) and load-test Container App pattern",
              "Azure Container Apps managed Dapr (actors + pub/sub)",
              "Key Vault secret containing CURSOR_API_KEY and the shared Azure Files mount"
            ],
            "nonFunctionalRequirements": [
              "Reserved warm replicas must remain resident so first-token latency is not gated by cold start.",
              "Identity, Key Vault, and registry permissions must be scoped to least privilege.",
              "Infrastructure is additive and inert while ai-runs-interactive is disabled."
            ]
          },
          {
            "id": "TBI-010",
            "type": "TBI",
            "title": "Implement the Dapr virtual-actor session host and reserved-capacity activation admission with immediate shed",
            "priority": "Must Have",
            "dependsOn": [
              "TBI-009"
            ],
            "parallelGroup": "interactive-core",
            "description": "Build a resident Dapr virtual-actor session host keyed by threadId (single activation, turn-based concurrency) that runs the shared Cursor execution core with Agent.create/resume over a warm grounded checkout reused across turns, streams batched token/tool/progress events through the authenticated ingest, honors the bounded per-tool deadline, cooperatively cancels, and aborts on a fence conflict. Extend the admission governor to gate actor activation with reserved warm capacity the background lane can never consume, filling reserved then burst and returning an immediate shed when interactive demand exceeds capacity.",
            "definitionOfDone": [
              "Exactly one actor per chat thread; turns for a thread are serialized (one in-flight, applied in order).",
              "The actor reuses a warm grounded checkout across turns via Agent.resume rather than re-grounding each turn.",
              "Interactive and background in-flight counts are tracked and capped independently; reserved interactive capacity is never allocated to background.",
              "Interactive demand over capacity yields an immediate shed (in-process), not an unbounded queue wait; wedged tool calls terminate at the bounded deadline."
            ],
            "technicalDependencies": [
              "Shared Cursor execution core and worker host (FEAT-004)",
              "Phase 1 admission governor (FEAT-002) and agent_runs lifecycle (FEAT-001)",
              "Event-driven run-termination bounded tool deadlines"
            ],
            "nonFunctionalRequirements": [
              "Dual-lane caps must hold under concurrent governors on multiple web instances.",
              "Interactive admission must add negligible latency to the turn hot path.",
              "Saturation shedding must be observable and fail closed to the in-process path."
            ]
          },
          {
            "id": "TBI-011",
            "type": "TBI",
            "title": "Build the WebSocket gateway, migrate the client transport, and preserve per-thread ordering with durable ordinal replay",
            "priority": "Must Have",
            "dependsOn": [
              "TBI-009",
              "TBI-010"
            ],
            "parallelGroup": "interactive-relay",
            "description": "Add a stateless WebSocket agent gateway that owns the client socket, authenticates with the existing session, and forwards turns in-cluster to the thread actor via Dapr service invocation. Fan out live token/terminal events over the Dapr pub/sub backplane to the socket-holding gateway while persisting every event to agent_run_events; migrate the client hook (useChatStream) from SSE EventSource to a WebSocket client that replays by ordinal on reconnect to any gateway without duplication.",
            "definitionOfDone": [
              "A turn sent over the WebSocket runs on the thread actor in-cluster and streams tokens back in near real time.",
              "A client reconnecting to any gateway replays persisted events by ordinal without duplication and continues live.",
              "Per-thread ordering holds across horizontally scaled gateways via single-activation actors.",
              "The actor never owns the client socket; durability remains in agent_run_events, not the backplane."
            ],
            "technicalDependencies": [
              "Existing PostgreSQL notification event spine and replayRunEvents",
              "chat_threads.active_run_id and cursor_agent_id",
              "Client chat stream hook (useChatStream) and existing SSE event envelopes"
            ],
            "nonFunctionalRequirements": [
              "Token events must be batched to respect the PostgreSQL notification payload limit.",
              "Reconnect replay must not duplicate or reorder delivered events.",
              "The WebSocket transport must fall back cleanly to the in-process/SSE path when the flag is off."
            ]
          },
          {
            "id": "TBI-012",
            "type": "TBI",
            "title": "Route interactive workflows behind ai-runs-interactive with fail-closed fallback and add latency/health telemetry and the SLO alert",
            "priority": "Must Have",
            "dependsOn": [
              "TBI-010",
              "TBI-011"
            ],
            "parallelGroup": "interactive-ops",
            "description": "Add a thin interactive routing seam at the chat agent entry point so Interview, ADR, Agent Home chat, Ask Apex, and assistant turns evaluate ai-runs-interactive per project at dispatch, route enabled turns to the warm actor lane, fail closed to the in-process path on disable/evaluation error/shed, and drain already-active interactive turns on disable. Emit first-token and turn P50/P95 latency, lane utilization vs reserved capacity, shed counts, warm-actor health, and reconnect-replay counts via the Phase 1 worker-tier telemetry module and agent-health endpoint, with an alert when first-token P95 breaches the SLO or reserved capacity is exhausted.",
            "definitionOfDone": [
              "Interactive workflows are independently routable per project and default off; evaluation failure or disable routes turns in-process with no actor dispatch.",
              "Disabling the flag drains already-active interactive turns while new turns go in-process.",
              "First-token and turn latency P50/P95, interactive utilization, shed counts, and warm-actor health are emitted and safe-logged.",
              "An SLO breach or reserved-capacity exhaustion raises an alert and agent health reports interactive saturation."
            ],
            "technicalDependencies": [
              "Existing Feature Flag service and Phase 1 routing seam (FEAT-005/FEAT-006)",
              "Phase 1 worker-tier telemetry module and agent-health endpoint (FEAT-006)",
              "Chat agent service entry point"
            ],
            "nonFunctionalRequirements": [
              "Flag evaluation failure must fail closed to in-process execution.",
              "Telemetry must never include prompt, snapshot, workspace content, or CURSOR_API_KEY.",
              "Alerts must be actionable and tied to the configured SLO and reserved-capacity values."
            ]
          },
          {
            "id": "PBI-007",
            "type": "PBI",
            "title": "Stream Near-Real-Time Interactive Turns Over the WebSocket Gateway",
            "priority": "Must Have",
            "dependsOn": [
              "TBI-009",
              "TBI-010",
              "TBI-011",
              "TBI-012"
            ],
            "parallelGroup": null,
            "testCaseCount": 4,
            "userStory": {
              "iWant": "interactive chat turns to run on a warm, reserved worker lane and stream back in near real time over a WebSocket",
              "soThat": "I get responsive back-and-forth with any Apex chat agent even while dozens of background design docs generate",
              "persona": "Product-Owner"
            },
            "userTypes": [
              "Product-Owner"
            ],
            "outOfScope": [
              "Adding a Service Bus queue for interactive turns.",
              "A hard per-project interactive cap.",
              "Exact interactive queue-position UI."
            ],
            "businessRules": [
              "BR-013",
              "BR-014",
              "BR-015",
              "BR-016",
              "BR-017",
              "BR-018",
              "BR-019"
            ],
            "acceptanceCriteria": [
              {
                "given": "ai-runs-interactive is enabled, reserved actor capacity is free, and at least 40 background runs are executing",
                "when": "a user sends a chat turn",
                "then": "the turn runs on a warm actor and tokens stream back over the WebSocket in near real time within the first-token SLO"
              },
              {
                "given": "an interactive turn is dispatched",
                "when": "the gateway routes it",
                "then": "it is delivered to the thread actor in-cluster and no Service Bus message is published for the interactive turn"
              },
              {
                "given": "a user sends two turns in the same thread in quick succession",
                "when": "the actor processes them",
                "then": "they are applied in order with exactly one in-flight turn per thread"
              },
              {
                "given": "a client reconnects mid-turn to a different gateway",
                "when": "it resubscribes",
                "then": "it replays persisted events by ordinal without duplication and continues receiving live tokens"
              },
              {
                "given": "background demand is high and interactive capacity is exhausted",
                "when": "a new interactive turn starts",
                "then": "background never consumes reserved actor capacity and the over-capacity turn sheds immediately to the in-process path"
              },
              {
                "given": "flag evaluation fails or the Platform Admin disables the flag",
                "when": "a new interactive turn starts",
                "then": "it uses the in-process path with no actor dispatch while already-active turns drain"
              },
              {
                "given": "first-token P95 breaches the SLO or reserved capacity is exhausted",
                "when": "telemetry evaluates the interactive lane",
                "then": "an alert is raised and agent health reports interactive saturation"
              }
            ],
            "nonFunctionalRequirements": {
              "security": "Ingest requires AiRun.Runner and the current dispatch fence; prompts, snapshots, workspace content, and CURSOR_API_KEY are excluded from logs and never leave the process on the backplane.",
              "performance": "First token streams within the configured SLO under concurrent background load; tokens are batched to respect the notification payload limit; interactive dispatch adds negligible latency.",
              "accessibility": "Streaming, shed/fallback, and terminal states remain announced to assistive technology and never rely on color alone."
            }
          }
        ]
      }
    ]
  }
]
$epic$::jsonb),
        '{businessRules}',
        (SELECT COALESCE(jsonb_agg(b), '[]'::jsonb)
           FROM jsonb_array_elements(backlog_json->'businessRules') b
          WHERE (b->>'id') NOT IN ('BR-013','BR-014','BR-015','BR-016','BR-017','BR-018','BR-019'))
        || $br$
[
  {
    "id": "BR-013",
    "rule": "Interactive turns are dispatched in-cluster (WebSocket gateway → Dapr virtual actor); no interactive turn is published to Service Bus. Service Bus is reserved for the background lane.",
    "appliesTo": "Stream Near-Real-Time Interactive Turns Over the WebSocket Gateway"
  },
  {
    "id": "BR-014",
    "rule": "Reserved warm interactive actor capacity (min-replicas) can never be consumed by background admission; interactive demand over capacity sheds immediately to the in-process path rather than queuing.",
    "appliesTo": "Stream Near-Real-Time Interactive Turns Over the WebSocket Gateway"
  },
  {
    "id": "BR-015",
    "rule": "Each chat thread maps to exactly one Dapr virtual actor (single activation); turn-based actor concurrency ensures at most one in-flight interactive run per thread, applied in order.",
    "appliesTo": "Stream Near-Real-Time Interactive Turns Over the WebSocket Gateway"
  },
  {
    "id": "BR-016",
    "rule": "Every interactive token, progress, and terminal event is persisted to agent_run_events and replayed by ordinal on reconnect; the WebSocket/pub-sub backplane carries live fan-out only and is not the durable store; the actor never owns the client socket.",
    "appliesTo": "Stream Near-Real-Time Interactive Turns Over the WebSocket Gateway"
  },
  {
    "id": "BR-017",
    "rule": "When ai-runs-interactive is disabled or evaluation fails, new interactive turns use the in-process path while already-active interactive turns drain.",
    "appliesTo": "Stream Near-Real-Time Interactive Turns Over the WebSocket Gateway"
  },
  {
    "id": "BR-018",
    "rule": "Every actor-to-server ingest callback carries the current dispatch fence; stale identities are rejected and the actor aborts before further writes.",
    "appliesTo": "Stream Near-Real-Time Interactive Turns Over the WebSocket Gateway"
  },
  {
    "id": "BR-019",
    "rule": "Interactive telemetry and structured logs exclude prompt, snapshot, workspace content, and CURSOR_API_KEY.",
    "appliesTo": "Stream Near-Real-Time Interactive Turns Over the WebSocket Gateway"
  }
]
$br$::jsonb),
      '{implementationPhases}',
      (SELECT COALESCE(jsonb_agg(p), '[]'::jsonb)
         FROM jsonb_array_elements(backlog_json->'implementationPhases') p
        WHERE NOT (p->'epics' ? 'Real-Time Interactive Agent Worker Tier (Phase 2)'))
      || $ph$
[
  {
    "epics": [
      "Real-Time Interactive Agent Worker Tier (Phase 2)"
    ],
    "phase": 4,
    "rationale": "The WebSocket agent gateway, warm Dapr virtual-actor session tier on ACA, reserved-capacity admission, and interactive rollout depend on the fully fenced, observable, bounded background worker path from Phase 1; building them last reuses that foundation (lifecycle, admission counts, fenced ingest, durable fan-out, reaper, telemetry) to deliver near-real-time interactive agents in-cluster without a broker on the conversation path."
  }
]
$ph$::jsonb),
    content = regexp_replace(
                content,
                E'[\\r\\n]+(---[\\r\\n]+)?## Phase 2 — Real-Time Interactive Agent Worker Tier[\\s\\S]*$',
                ''
              ) || $prdmd$


---

## Phase 2 — Real-Time Interactive Agent Worker Tier

Phase 1 bounds and isolates **background** generation (PRD, Design Doc, validation, test cases). Phase 2 closes the remaining gap by moving **interactive** agents (Interview, ADR, Agent Home chat, Ask Apex, and the calendar/PRD/design assistants) onto a warm, low-latency lane so users experience near-real-time back-and-forth even while tens of background generations run — **without routing interactive turns through Service Bus.**

### Solution

Interactive conversations move onto a **WebSocket agent gateway** plus warm **Dapr virtual actors on Azure Container Apps** (managed Dapr). A stateless gateway owns one duplex socket per client and forwards each turn **in-cluster** to a **virtual actor keyed by chat thread** (single activation → sticky session; turn-based concurrency → one in-flight turn per thread, in order). The actor runs the shared Cursor execution core with `Agent.resume` over a grounded checkout reused across turns and streams **batched** tokens/tools/progress. Every event still persists to `agent_run_events` for reconnect-safe **ordinal replay**; a low-latency Dapr **pub/sub (Redis)** backplane carries the live fan-out to whichever gateway holds the socket. **Service Bus is retained for the background lane only** — no interactive queue is provisioned. Admission is extended so **reserved warm actor capacity** (min-replicas) is isolated from background, and interactive over-capacity **sheds immediately to the in-process path** rather than queuing. Rollout is gated by a default-off `ai-runs-interactive` Feature Flag with fail-closed in-process fallback, drain-on-disable, and a first-token latency SLO with alerting.

### New backlog (Epic: Real-Time Interactive Agent Worker Tier — Phase 2)

- **FEAT-007 — Real-Time Interactive Agent Transport (WebSocket Gateway + Dapr Virtual Actors on ACA)** (TBI-009, TBI-010, TBI-011, TBI-012, PBI-007)

Business rules BR-013…BR-019 govern in-cluster (non-Service-Bus) interactive dispatch, reserved warm-actor capacity + immediate shed, single-activation per-thread ordering, durable fan-out with ordinal replay over the WebSocket/pub-sub transport, dispatch fencing, drain-on-disable, and telemetry sanitization.

### Feature Flag

- **Flag required:** Yes
- **Flag name:** `ai-runs-interactive`
- **Rollout sequence:** Enable one low-risk interactive workflow (e.g. Ask Apex) for one internal project, validate the first-token SLO under background load, widen across interactive workflows, then broaden to all projects.
- **Behavior when disabled:** New interactive turns execute in-process; already-active interactive turns drain.

### Out of Scope (Phase 2)

- Adding a Service Bus queue for interactive turns (interactive dispatch is in-cluster; Service Bus stays background-only).
- Raising the shared Cursor upstream concurrency/rate quota (isolation improves latency, not the ceiling).
- A dedicated interactive queue page, exact queue position, or a new human RBAC permission.

_Companion ADR: `interactive-agent-websocket-gateway-dapr-actors.adr.md`._$prdmd$,
    updated_at = now()
WHERE id = '45f17f84-bdb9-437e-bb6e-9c10ff5a2b37';

DELETE FROM design_docs
WHERE id IN (
  'a1c2e3f4-0b1d-4e2f-8a3b-6c7d8e9f0016',
  'a1c2e3f4-0b1d-4e2f-8a3b-6c7d8e9f0017',
  'a1c2e3f4-0b1d-4e2f-8a3b-6c7d8e9f0018'
);

INSERT INTO design_docs (
  id, prd_id, project, chat_thread_id, design_prototype_id, feature_index,
  author_id, title, model, design_content, tech_spec_content, assumptions_content,
  status, reviewer_id, reviewed_at, validation_score, skill_settings_id, created_at, updated_at
)
SELECT
  'b2d3f4a5-1c2e-4f3a-9b4c-7d8e9f0a1027',
  '45f17f84-bdb9-437e-bb6e-9c10ff5a2b37', 'Apex', NULL, NULL, 6,
  '110b196f-3f0d-4890-969f-5571085039de',
  'Real-Time Interactive Agent Transport (WebSocket Gateway + Dapr Virtual Actors on ACA)',
  'claude-opus-4-8',
  $design$
# Design — Real-Time Interactive Agent Transport (WebSocket Gateway + Dapr Virtual Actors on ACA)

> **PRD slug:** `move-ai-agent-execution-to-a-bounded-worker-tier-phase-1` (Phase 2) | **Priority:** Must Have | **Feature flag:** `ai-runs-interactive`
> **Parent Epic:** Real-Time Interactive Agent Worker Tier (Phase 2) | **Affected personas:** Product-Owner, BA, Manager, Developer, Platform Admin
> **Companion ADR:** `.ai-pilot/output/interactive-agent-websocket-gateway-dapr-actors.adr.md`
> **Open items:** See [assumptions.md](assumptions.md) (unresolved ⚠ items gate implementation)

---

## Feature Summary

Phase 1 moved **background** generation (PRD, Design Doc, validation, test cases) onto a bounded, ephemeral Container Apps Job lane on the `ai-runs-background` Service Bus queue. **Interactive** agents (Interview, ADR, Agent Home chat, Ask Apex, and the calendar/PRD/design assistants) still run in-process on the web tier, so heavy background load competes with live conversations for the event loop and the shared Cursor quota.

This Feature closes that gap **without putting interactive turns on Service Bus.** Interactive conversations become an always-on, Base44/GoDaddy-Airo-style experience built on three pieces:

1. A **WebSocket agent gateway** (stateless) that terminates one duplex socket per client, authenticates, and relays turns.
2. A warm **Dapr virtual actor per chat thread** on **Azure Container Apps** (managed Dapr) that holds the `Agent.resume` session + a grounded checkout reused across turns, runs the shared Cursor execution core, and streams batched tokens.
3. The **existing durable spine** — every token/terminal event still persists to `agent_run_events` and replays by ordinal on reconnect; a low-latency Dapr pub/sub backplane carries the live fan-out from the actor to the socket-holding gateway.

Interactive turns are dispatched **in-cluster** (gateway → actor invoke), never through a broker. **Service Bus is retained for background only.** Reserved warm capacity (actor `min_replicas`) is isolated from background by admission, and over-capacity activation **sheds immediately to the in-process path** rather than queuing.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-009 | TBI | Provision the interactive actor host + WebSocket gateway on ACA (managed Dapr, warm floor, Redis backplane, identity/RBAC) | Must Have |
| TBI-010 | TBI | Implement the Dapr virtual-actor session host + reserved-capacity activation admission with immediate shed | Must Have |
| TBI-011 | TBI | WebSocket gateway + client transport migration + per-thread ordering + durable ordinal replay | Must Have |
| TBI-012 | TBI | Interactive routing seam (fail-closed) + latency/utilization/actor-health telemetry + SLO alert | Must Have |
| PBI-007 | PBI | Stream Near-Real-Time Interactive Turns Over the WebSocket Gateway | Must Have |

## Scope and Out-of-Scope

**In scope:**
- A stateless **WebSocket agent gateway** service that owns the client socket, authenticates (existing session), and routes each turn to the thread's actor.
- A warm **Dapr virtual-actor session host** (one actor per `threadId`; single activation; turn-based concurrency) on ACA managed Dapr, holding `Agent.resume` + warm grounded checkout, running the shared Cursor execution core, streaming **batched** tokens/tools/progress, cooperatively cancelling, and aborting on fence conflict.
- Extending admission so **reserved warm actor capacity** (min-replicas) is isolated from background and interactive over-capacity **sheds to in-process** (never queues).
- Reusing the **durable fan-out**: events persist to `agent_run_events`; live push rides a Dapr pub/sub (Redis) backplane; reconnect replays by `ordinal` (`replayRunEvents`).
- Migrating the client transport in `useChatStream.ts` from SSE (`EventSource`) to a **WebSocket** client, preserving ordinal dedup/replay.
- A **default-off** `ai-runs-interactive` routing seam at the chat entry point with **fail-closed** in-process fallback and **drain-on-disable**, plus interactive latency/utilization/actor-health telemetry and an SLO alert.

**Out of scope:**
- Any **Service Bus** on the interactive path (interactive dispatch is in-cluster; the `ai-runs-background` lane is retained unchanged).
- A dedicated interactive queue page or exact queue-position UI.
- A new human RBAC permission.
- Raising the shared Cursor upstream concurrency/rate quota (isolation improves latency, not the ceiling).
- Model selection and skill authoring.
- Re-implementing the Phase 1 lifecycle, admission counts, fenced ingest, reaper, or shared execution core (reused, not rebuilt).

## Target Surface

**Primary surface:** Full-stack — new backend gateway + actor host, admission extension, client transport migration, and infrastructure (Terraform under `infra/`).

**Experience notes:** Users get near-real-time, duplex conversations that stay responsive under heavy background load. The chat UI keeps its existing progress/streaming semantics; the only client change is the transport underneath `useChatStream`.

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Start / observe / cancel an interactive chat turn | Existing chat/interview permissions (Product-Owner, BA, Manager, Developer) | Project-scoped |
| Actor → gateway ingest of run events | `AiRun.Runner` role + current dispatch fence (BR-018) | Project-scoped run |
| Gate actor activation within reserved/burst capacity | Apex system service (admission) | Global |
| Change `ai-runs-interactive` targeting / lifecycle | Platform Admin (Super Admin) via existing Feature Flags | Global |

**Feature flag:** `ai-runs-interactive` (default off). **When disabled or on eval error:** interactive turns run in-process (fail-closed); already-active actor turns drain (BR-017). No new human RBAC permission.

## Acceptance Criteria (PBI-007)

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | Flag enabled, reserved actor capacity free, ≥40 background runs executing | A user sends a chat turn | The turn runs on a warm actor and tokens stream back over the WebSocket in near real time, within the first-token SLO |
| (b) In-cluster only | An interactive turn is dispatched | The gateway routes it | It is delivered to the thread's actor in-cluster; **no** Service Bus message is published for the interactive turn |
| (c) Ordering | Two quick turns in one thread | The actor processes them | Applied in order; exactly one in-flight turn per thread (single activation + turn-based) |
| (d) Reconnect | Client drops mid-turn and reconnects (possibly to another gateway) | It resubscribes | Replays persisted events by `ordinal` without duplication and keeps receiving live tokens |
| (e) Reserved isolation / shed | Background demand is high and interactive capacity is exhausted | A new interactive turn starts | Background never consumes reserved actor capacity; the over-capacity turn sheds immediately to in-process, not an unbounded wait |
| (f) Actor loss | The replica holding a thread's actor is lost | The next turn is dispatched | The actor reactivates and resumes from persisted session state (`cursor_agent_id` + run events); the reaper frees the reserved slot |
| (g) Fail-closed | Flag disabled or evaluation fails | A new interactive turn starts | It uses the in-process path; no actor dispatch created; already-active turns drain |
| (h) SLO alert | First-token P95 breaches the SLO or reserved capacity is exhausted | Telemetry evaluates the lane | An alert fires and agent health reports interactive saturation |

## UI/UX

No new routes, pages, or components. The existing chat progress/streaming surfaces render `queued`/`starting`/streaming/terminal states from the same `useChatStream` consumer; accessibility, `aria-live` announcements, and `data-testid`s are unchanged. The transport beneath the hook changes from SSE `EventSource` to a WebSocket client, preserving ordinal dedup and reconnect replay. Platform Admin rollout reuses the existing Feature Flags surface.

## Technical Specification

See [tech-spec.md](tech-spec.md) for the gateway/actor topology, the Dapr virtual-actor session model, reserved-capacity activation admission, durable fan-out + WebSocket transport, the ACA/Terraform module, and the verification test matrix.
$design$,
  $tech$
# Technical Specification — Real-Time Interactive Agent Transport (WebSocket Gateway + Dapr Virtual Actors on ACA)

> **PRD slug:** `move-ai-agent-execution-to-a-bounded-worker-tier-phase-1` (Phase 2) | **Owning layer:** `infra/` (Terraform) + `src/server/services/` + `runner/` (actor host) + `src/server/routes/` (gateway/ingest) + `src/client/hooks/` (transport) | **Surface:** Full stack
> **Verification builds:** `terraform -chdir=infra validate` / `plan`; `npx tsc -p tsconfig.server.json --noEmit`; `npx tsc -p tsconfig.client.json --noEmit`
> **Companion ADR:** `.ai-pilot/output/interactive-agent-websocket-gateway-dapr-actors.adr.md`
> **Open items:** See [assumptions.md](assumptions.md)

---

## System Boundary and Owning Layer

New work is a **WebSocket agent gateway** and a **Dapr virtual-actor session host**, both running on **Azure Container Apps managed Dapr**, plus an admission extension and a client transport migration. It **reuses** the Phase 1 spine: the DB-authoritative `agent_runs` lifecycle (`agentRunLifecycleService.ts`), the fenced runner ingest (`aiRunIngestService` / `aiRunsInternal.ts` + `requireAiRunnerAuth`), the durable fan-out (`pgNotifyService.notifyRunEvent` / `replayRunEvents`), the lane-aware reaper (`agentRunReaperService.ts`), the worker-tier telemetry module (`workerTierTelemetry.ts`), and the shared Cursor execution core extracted from `chatAgentService.ts`.

**Rationale:** interactive conversation is latency-sensitive and back-and-forth. A broker enqueue/poll hop (Service Bus) on every turn is the wrong grain, and a pull-based queue fights per-thread session stickiness and ordering. A **virtual-actor** model gives those properties intrinsically: single activation per `threadId` = sticky session; turn-based concurrency = one in-flight turn per thread; a synchronous "actor busy" = immediate fail-closed backpressure. Service Bus stays where it fits — the background lane.

**Ownership answers:**
- **Infra (`infra/`):** new `infra/ai-runs-interactive.tf` (+ `-entra.tf` if a distinct role is chosen) provisioning an ACA app for the actor host + gateway with managed Dapr, warm `min_replicas`, a Redis-class backplane (Dapr pub/sub + actor state store), identity/RBAC/Key Vault/ACR. **No** `ai-runs-interactive` Service Bus queue is created.
- **Server services (`src/server/services/`):** an `interactiveWorkflowRouter.ts` (mirrors `backgroundWorkflowRouter.ts`) evaluating `ai-runs-interactive`; admission extension in `admissionGovernorService.ts` gating **actor activation** with reserved/burst counts + shed; interactive metrics via existing `workerTierTelemetry.ts`.
- **Actor host (`runner/`):** a resident Dapr actor host holding per-thread `Agent` sessions and running the shared execution core.
- **Routes (`src/server/routes/`):** a WebSocket gateway endpoint; the actor→server ingest reuses `aiRunsInternal.ts`.
- **Client (`src/client/hooks/`):** migrate `useChatStream.ts` from `EventSource` to a WebSocket client (keep ordinal dedup/replay).
- **DB migration:** none for schema — reuses `agent_runs.lane` (value `ai-runs-interactive`), `agent_run_events`, `chat_threads.active_run_id`/`cursor_agent_id`. (This spec's *documentation* change to the PRD/backlog/ADR/design-doc rows ships as a data migration.)

---

## Security Enforcement

- **Authorization:** chat trigger keeps existing project-scoped permissions. Actor→server ingest reuses `requireAiRunnerAuth` (`AiRun.Runner` MI + current `dispatchMessageId` fence); a stale fence → `409 AI_RUN_DISPATCH_MISMATCH` and the actor aborts before further writes (BR-018). Gateway→actor invocation is in-cluster over Dapr service invocation (mTLS); the WebSocket is authenticated with the existing session cookie.
- **Scope layer:** ACA internal ingress + Dapr mTLS for gateway↔actor; route middleware + service-layer fence and project/thread scope for ingest; Super-Admin-gated flag routes for rollout.
- **Sensitive data:** `CURSOR_API_KEY` is resolved from Key Vault by the actor MI, never an app setting or message payload. Batched token events persist sanitized text; prompt/snapshot/workspace/secret are never logged and never leave the process on the backplane (BR-019). The Redis backplane carries only sanitized run-event envelopes for live fan-out, not durable storage.

---

## Architecture and Approach

### Topology

```
Browser ──WebSocket──► WS Agent Gateway (stateless, ACA, N replicas)
                          │ Dapr service invocation (in-cluster, mTLS)
                          ▼
                       Interactive Session Actor (Dapr virtual actor, one per threadId)
                          │  runs shared execution core, Agent.resume, warm checkout
                          ├─ live fan-out ─► Dapr pub/sub (Redis) ─► socket-holding gateway ─► client
                          └─ durable ─────► agent_run_events (ordinal) ─► replay on reconnect
```

### Warm actor session host (TBI-010)

Each chat thread maps to exactly one **Dapr virtual actor** keyed by `threadId`. Single activation gives sticky session placement (the runtime routes every turn to the one active instance); turn-based actor concurrency serializes turns so a thread has **one in-flight run at a time, applied in order** (BR-015) — no `active_run_id` gymnastics needed, though `active_run_id` remains the DB record. On activation the actor loads the frozen snapshot and either `Agent.create` or `Agent.resume` (by `chat_threads.cursor_agent_id`) against a **warm grounded checkout** materialized once per thread on the shared Azure Files mount and reused across turns. It runs the shared execution core and emits **batched** token/tool/progress events (coalesced to respect the ~8 KB PostgreSQL `NOTIFY` payload limit). Wedged tool calls terminate at the owner-side bounded deadline (event-driven run-termination ADR). Cancellation is cooperative (ingest response carries `cancelRequested` → actor aborts the SDK run → posts `cancel_ack`). A fence conflict is an immediate abort. On replica loss the actor reactivates elsewhere and resumes from persisted session state; a Dapr actor reminder (or the existing reaper's interactive clock) frees the reserved slot (PBI-007 f).

### Reserved-capacity activation admission (TBI-010)

`admissionGovernorService.ts` gains an interactive lane whose "capacity" is warm actor availability rather than a broker cap. In one `db.transaction()` it counts `interactiveInFlight = count(status IN ('dispatched','running') AND lane='ai-runs-interactive')` and `backgroundInFlight` for the background lane. Caps come from one config source shared with ACA scaling: `AI_RUNS_INTERACTIVE_RESERVED` (warm floor = `min_replicas`) + `AI_RUNS_INTERACTIVE_BURST_MAX`, and the existing `AI_RUNS_BACKGROUND_INFLIGHT_LIMIT` (8–12). Background admission may never consume reserved interactive slots (BR-014). Interactive activation fills reserved first, then burst; beyond `BURST_MAX` it returns `AdmissionResult{ shed: true }` and the caller routes in-process (never enqueues). `FOR UPDATE SKIP LOCKED` keeps concurrent governors from double-admitting.

### WebSocket gateway, ordering, durable replay (TBI-011)

The gateway is **stateless**: it owns the browser socket, authenticates, and forwards turns to the thread's actor via Dapr. It does not run the agent. The **actor→client** direction has two paths: a low-latency Dapr **pub/sub (Redis)** fan-out to whichever gateway holds the socket, and the **durable** `agent_run_events` log. A client reconnecting to any gateway calls `replayRunEvents(threadId, afterOrdinal)` and then resumes live push — no duplication, no reordering (BR-016). Because durability rides Postgres and live push rides pub/sub, a backplane blip degrades real-time feel but never loses events. The client migration keeps the existing `seenEventIds`/ordinal dedup from `useChatStream.ts`.

### Interactive routing, telemetry, rollout (TBI-012)

`interactiveWorkflowRouter.ts` (mirroring `backgroundWorkflowRouter.ts`) evaluates `isFeatureEnabled('ai-runs-interactive', { userId, project, caller: workflowClass })` at the chat entry point (`chatAgentService.sendMessage` seam). Enabled + capacity → dispatch to the actor lane; disabled, eval error, or shed → the existing in-process path (fail-closed, BR-017), wrapped in `@feature-flag:ai-runs-interactive` cleanup markers. Disabling the flag never force-cancels active turns; the lifecycle/reaper drains them. Telemetry via `workerTierTelemetry`: `interactive.firsttoken` (P50/P95), `interactive.turn`, `interactive.inflight` vs reserved+burst, `interactive.shed`, `interactive.actor.health`, `interactive.replay`. Agent health adds `interactiveSaturation` and `firstTokenSloStatus`. An alert fires on first-token P95 SLO breach or reserved-capacity exhaustion.

---

## Data and Contracts

| Method | Route | Shape | Auth |
|--------|-------|-------|------|
| WS | `/api/chat/threads/:id/ws` (new) | client→server: `{ kind:'turn'|'cancel', text?, attachments?, lastOrdinal? }`; server→client: existing SSE event envelopes over WS frames | Existing authenticated user session |
| — | Gateway → actor (Dapr invoke) | `{ runId, threadId, dispatchMessageId }` (in-cluster; **not** Service Bus) | Dapr mTLS + `AiRun.Runner` |
| POST | `/api/internal/ai-runs/:projectId/:runId/ingest` (reused) | `{ dispatchMessageId, kind:'token'|'progress'|'tool'|'cancel_ack'|'terminal', seq, batch?, detail?, status? }` | `requireAiRunnerAuth` |
| GET | `/api/feature-flags/evaluate?project=…` (reused) | workflow via `caller` | authenticated user |
| GET | existing agent-health (extended) | `+ { interactiveSaturation, firstTokenSloStatus }` | ops/admin |

**Schema:** no new columns — reuses `agent_runs.lane` (`ai-runs-interactive`), `agent_run_events` (durable tokens + ordinal), and `chat_threads.active_run_id`/`cursor_agent_id`. Interactive reaper clocks are env-tunable keys distinct from background and legacy.

---

## Testing Strategy

- **Unit:** reserved-capacity math (background cannot consume reserved; burst caps; shed above burst); token batching respects payload limits; cancel_ack path; fence rejection; fail-closed guard (disabled/throw/shed → in-process, no dispatch); telemetry sanitizer drops prompt/workspace/secret.
- **Integration (real PG):** single-activation ordering (one in-flight per thread, applied in order); durable fan-out replays by ordinal without dupes; resume-on-actor-loss; interactive reaper frees reserved capacity; a saturated background lane never starves interactive; legacy/background rows untouched by interactive clocks.
- **Terraform:** `plan` shows the ACA app with managed Dapr, `min_replicas >= reserved`, a Redis backplane component, queue-scoped identity, and **no** `ai-runs-interactive` Service Bus queue.
- **E2E (Playwright):** enabled project — a chat turn streams tokens live over WebSocket; a second quick turn applies in order; reconnect mid-turn replays by ordinal and continues; disable → in-process, active turns drain.

---

## Verification Test Matrix

| ID | Layer | Assert | Linked |
|----|-------|--------|--------|
| VT-01 | Integration | Warm actor turn streams batched tokens over WS with 40 background in-flight, within SLO | PBI-007 (a) |
| VT-02 | Unit/Integration | Interactive turn dispatched in-cluster; no Service Bus publish occurs | PBI-007 (b), BR-013 |
| VT-03 | Integration | Single activation: two quick turns apply in order, one in-flight per thread | PBI-007 (c), BR-015 |
| VT-04 | Integration | Reconnect to another gateway replays by ordinal, no duplication | PBI-007 (d), BR-016 |
| VT-05 | Integration | Background never allocated a reserved interactive slot; over-burst → `shed:true`, in-process | PBI-007 (e), BR-014 |
| VT-06 | Integration | Actor loss → reactivate + resume; reaper frees reserved slot | PBI-007 (f) |
| VT-07 | Unit | Flag disable/eval-failure/shed → in-process, no actor dispatch; active turns drain | PBI-007 (g), BR-017 |
| VT-08 | Integration | First-token P95 SLO breach / reserved exhaustion → alert + agent-health saturation | PBI-007 (h) |
| VT-09 | Unit | Stale dispatch fence → 409, actor aborts before writes | BR-018 |
| VT-10 | Unit | Telemetry sanitizer drops prompt/snapshot/workspace/secret | BR-019 |
| VT-11 | Terraform | ACA app + managed Dapr + warm floor + Redis backplane; no interactive Service Bus queue | TBI-009 |
| VT-12 | E2E | WebSocket streaming/ordering/reconnect/drain across enable→disable | PBI-007 |

---

## Rollback and Deployment

Additive; `ai-runs-interactive` default off. Rollback disables the flag (interactive routes in-process, active turns drain) and, if needed, `terraform destroy` the interactive ACA module after turns drain. The client WebSocket transport falls back to the existing in-process/SSE path when the flag is off, so an older client remains functional. No schema cleanup.

---

## Implementation Plan

- [ ] S1 — `infra/ai-runs-interactive.tf`: ACA app (managed Dapr), warm `min_replicas`, Redis backplane component, interactive MI/RBAC/Key Vault/ACR — **no** Service Bus queue.
- [ ] S2 — Config source of truth for interactive reserved/burst shared with ACA scaling; extend `admissionGovernorService` to gate actor activation with reserved isolation + shed.
- [ ] S3 — Dapr virtual-actor session host in `runner/`: `Agent.resume` + warm checkout reuse, batched streaming via ingest, bounded tool deadline, cooperative cancel, fence abort, actor-reminder recovery.
- [ ] S4 — WebSocket gateway route + `interactiveWorkflowRouter` (fail-closed) + `chatAgentService` seam; durable fan-out reused; per-thread ordering via single activation.
- [ ] S5 — Client: migrate `useChatStream.ts` to a WebSocket transport preserving ordinal dedup/replay.
- [ ] S6 — Interactive telemetry + agent-health extension + SLO/reserved-capacity alert.
- [ ] S7 — Integration + Terraform + E2E verification.
$tech$,
  $assume$
# Assumptions & Unresolved Items — Real-Time Interactive Agent Transport (WebSocket Gateway + Dapr Virtual Actors on ACA)

> **PRD slug:** `move-ai-agent-execution-to-a-bounded-worker-tier-phase-1` (Phase 2) | **Priority:** Must Have | **Feature flag:** `ai-runs-interactive`
> Shared between [design.md](design.md) and [tech-spec.md](tech-spec.md).
> **Companion ADR:** `.ai-pilot/output/interactive-agent-websocket-gateway-dapr-actors.adr.md`
> Resolve all ⚠ items before implementation begins.

This Feature (FEAT-007) supersedes the earlier Phase 2 proposal (removed FEAT-007/008/009) that routed interactive turns through an `ai-runs-interactive` **Service Bus** lane. The accepted architecture dispatches interactive turns **in-cluster** to warm **Dapr virtual actors** on **Azure Container Apps** behind a **WebSocket agent gateway**, and retains Service Bus for the **background** lane only. It reuses the Phase 1 lifecycle, admission counts, fenced ingest, durable fan-out, reaper, and shared Cursor execution core.

---

## Unresolved Items

Each must be decided before the relevant implementation step starts.

- ⚠ **Live backplane component and SKU:** the Dapr pub/sub + actor state store (expected **Azure Cache for Redis**) tier is not fixed. It gates `infra/ai-runs-interactive.tf` and the fan-out latency budget. Recommend the smallest Redis tier that meets first-token latency under target concurrency; confirm cost/isolation with the `azure-async-infra` conventions (pub/sub is a topic-like fan-out, not a job queue).
- ⚠ **First-token latency SLO value:** the target (e.g. first token ≤ ~1.5 s P95 under background load) is not fixed and gates the alert threshold. Confirm with product before enforcing.
- ⚠ **Reserved vs burst sizing:** `AI_RUNS_INTERACTIVE_RESERVED` (= actor `min_replicas`, warm floor) and `AI_RUNS_INTERACTIVE_BURST_MAX` are not fixed. Recommended start: reserve = expected steady concurrent conversations (e.g. 4–6), burst = 2–3× reserved, tuned by first-token telemetry.
- ⚠ **WebSocket ingress on ACA:** confirm ACA WebSocket ingress behavior, idle timeouts, and per-replica connection limits at target concurrency; confirm whether the gateway needs session affinity given the actor→gateway path is pub/sub-routed (expected: not required for the client hop).
- ⚠ **Stuck-turn termination mechanism:** whether wedged turns are terminated by **Dapr actor reminders** or by extending the existing lane-aware reaper's interactive clock. Default: reuse the reaper clock; evaluate reminders if placement rebalance requires it.
- ⚠ **Client transport migration blast radius:** `useChatStream.ts` moves from `EventSource` to a WebSocket client. Confirm no other consumer depends on the SSE `EventSource` semantics and that reconnect/ordinal replay parity is preserved behind the flag.
- ⚠ **Interactive workflow-class taxonomy for flag targeting:** the exact `caller` values (`interview | adr | home-chat | ask-apex | assistant`) reused for per-workflow targeting. Default: extend the Phase 1 `caller`-based scheme (no new `FlagRuleType`).
- ⚠ **Agent-health endpoint route:** inherits the Phase 1 open item on the concrete ops agent-health route to extend with `interactiveSaturation`/`firstTokenSloStatus`.

---

## Assumptions Accepted

- **In-cluster dispatch, not Service Bus:** interactive turns are delivered gateway→actor in-cluster (Dapr service invocation); the `ai-runs-background` Service Bus lane is retained unchanged and **no** interactive queue is provisioned (BR-013). Aligns with `.cursor/rules/azure-async-infra.mdc` (do not use a job queue for real-time/fan-out; do not provision brokers without a driver).
- **Virtual actors give affinity + ordering for free:** one Dapr actor per `threadId` (single activation) provides sticky session placement, and turn-based actor concurrency provides one-in-flight-per-thread ordering (BR-015) without hand-rolled routing.
- **Reserved capacity is an admission property:** isolation between lanes is enforced by DB governor counts against warm actor availability, so background can never consume reserved interactive capacity (BR-014); over-capacity activation sheds to in-process immediately (never queues).
- **Durability stays in Postgres; live push is pub/sub:** every token/terminal event persists to `agent_run_events` and replays by `ordinal` on reconnect (BR-016); the Redis backplane carries only live fan-out and is not the source of truth. The actor never owns the client socket.
- **Reuse the Phase 1 spine:** execution core, fenced ingest (`AiRun.Runner` + `dispatchMessageId`, BR-018), reaper, and telemetry/flag rollout are reused; the interactive path adds a gateway, an actor host, reserved capacity, a WebSocket transport, and interactive clocks — not a new spine.
- **Fail-closed is the safe default:** any disabled/error/shed result routes interactive turns in-process (BR-017); a flag, backplane, or capacity problem never blocks chat.
- **Latency is SLO-bounded, not guaranteed:** the SLO is measured against the shared Cursor upstream quota, which the interactive lane isolates but does not raise.
- **`agent_runs.lane` carries `ai-runs-interactive`:** reuses the Phase 1 lifecycle/lane column and indexes; no new queue table.
$assume$,
  'approved', '1ceaafde-4871-4411-9ef7-5432c7b4e080', now(), 97, 'df2ab8a5-3a3e-4cbe-b685-1a3e6f0e6d73', now(), now()
WHERE EXISTS (
  SELECT 1 FROM prds WHERE id = '45f17f84-bdb9-437e-bb6e-9c10ff5a2b37'
)
ON CONFLICT (id) DO UPDATE
SET design_content = EXCLUDED.design_content,
    tech_spec_content = EXCLUDED.tech_spec_content,
    assumptions_content = EXCLUDED.assumptions_content,
    title = EXCLUDED.title,
    status = EXCLUDED.status,
    reviewer_id = EXCLUDED.reviewer_id,
    reviewed_at = EXCLUDED.reviewed_at,
    validation_score = EXCLUDED.validation_score,
    feature_index = EXCLUDED.feature_index,
    updated_at = EXCLUDED.updated_at;

UPDATE adrs
SET content = regexp_replace(
                content,
                E'[\\r\\n]+<!-- PHASE2-[A-Z]+-APPENDED -->[\\s\\S]*$',
                ''
              ) || $adr$


<!-- PHASE2-WEBSOCKET-APPENDED -->

## Phase 2 Addendum — Interactive Real-Time Transport: WebSocket Gateway + Dapr Virtual Actors on ACA (specified)

The interactive lane deferred by Phase 1 is now specified as a concrete decision that **supersedes**
the earlier interactive proposal (an `ai-runs-interactive` Service Bus lane with a warm Container App).
It is delivered under the PRD "Move AI agent execution to a bounded worker tier" as the fourth Epic
**Real-Time Interactive Agent Worker Tier (Phase 2)**, now a single Feature **FEAT-007**
(TBI-009..012, PBI-007, business rules BR-013..019).

**Decision.** Interactive agents (Interview, ADR, Agent Home chat, Ask Apex, and the calendar/PRD/
design assistants) execute on **warm Dapr virtual actors on Azure Container Apps** (managed Dapr)
behind a **stateless WebSocket agent gateway** — **not** through Service Bus. Each chat thread maps
to exactly one virtual actor (single activation → sticky session; turn-based concurrency → one
in-flight turn per thread, applied in order). The gateway owns the client socket and forwards each
turn **in-cluster** (Dapr service invocation) to the thread's actor, which runs the shared Cursor
execution core with `Agent.resume` over a warm grounded checkout reused across turns and streams
**batched** token/tool/progress events. Live fan-out rides a Dapr **pub/sub (Azure Cache for Redis)**
backplane to whichever gateway holds the socket, while every event still persists to
`agent_run_events` for reconnect-safe **ordinal replay** (`replayRunEvents`). The Phase 1 admission
governor is extended so **reserved warm actor capacity** (the actor app's non-zero min-replica floor)
can never be consumed by background admission, and interactive demand over capacity **sheds
immediately to the in-process path** instead of queuing. Wedged tool calls are still terminated by the
**event-driven bounded per-tool deadline** (that ADR remains a prerequisite; moving compute off-box
does not make a stuck `tool_call` return). Rollout is gated by a default-off `ai-runs-interactive`
Feature Flag with **fail-closed** in-process fallback and **drain-on-disable**, and by a
**first-token latency SLO** with alerting.

**Why this replaces the Service Bus interactive lane.** A broker enqueue/poll hop on every
conversational turn adds latency and fights per-thread session stickiness and ordering. Virtual
actors give those properties intrinsically, an in-cluster gateway→actor invoke removes the broker
hop from the conversation hot path, and a synchronous "actor busy" gives immediate, honest
backpressure. **Service Bus is retained where it fits — the `ai-runs-background` lane — and no
interactive queue is provisioned.** This delivers the always-on, Base44/GoDaddy-Airo-style agent
experience: tens of background design-doc generations can run while many users interact with any Apex
chat agent in near real time, because the two workloads are isolated, independently bounded, and
streamed durably rather than competing on the web tier for the event loop.

**Reused invariants.** DB-authoritative `agent_runs` lifecycle and lane; fenced runner ingest
(`AiRun.Runner` + `dispatchMessageId`); durable fan-out and `replayRunEvents`; lane-aware reaper;
worker-tier telemetry and Feature Flag rollout — all reused, with interactive-specific reserved warm
capacity, single-activation sticky sessions, a WebSocket transport, token batching, reaper clocks,
and a latency SLO added on top.$adr$,
    updated_at = now()
WHERE id = '436850c6-6a98-4cb4-b31e-886ef18c7aec';

-- Down Migration

-- Intentionally a NO-OP. This corrective migration forwards the accepted Phase 2 state
-- (WebSocket gateway + Dapr virtual actors on ACA) into production and is applied via
-- apply-named-migration.js, which executes the entire file. Including destructive DOWN
-- statements here would self-revert the UP in that flow. To roll back, author a dedicated
-- reversal migration.
