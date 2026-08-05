-- Seed Phase 2 of the "Move AI agent execution to a bounded worker tier" initiative.
--
-- Adds a fourth Epic ("Real-Time Interactive Agent Worker Tier (Phase 2)") to the approved
-- PRD 45f17f84-bdb9-437e-bb6e-9c10ff5a2b37, with three Features (FEAT-007..009), six TBIs
-- (TBI-009..014), three PBIs (PBI-007..009), and seven business rules (BR-013..019). It also
-- inserts three approved design docs (feature_index 6, 7, 8), folds a Phase 2 section into the
-- PRD markdown, and appends the concrete interactive-lane decision to the companion worker-tier
-- ADR (436850c6-6a98-4cb4-b31e-886ef18c7aec).
--
-- Phase 2 delivers the warm, low-latency interactive lane the Phase 1 PRD and the worker-tier ADR
-- explicitly deferred: a warm long-lived Container App on an `ai-runs-interactive` Service Bus
-- lane with reserved capacity and dual-lane fair admission, per-thread ordered dispatch with
-- near-real-time token streaming back over the existing PostgreSQL NOTIFY -> SSE spine, and a
-- fail-closed rollout behind the `ai-runs-interactive` Feature Flag with a first-token latency SLO.
-- Together with Phase 1 this lets tens of background design-doc generations run while many users
-- interact with any Apex chat agent in near real time — a Base44-style always-on agent experience.
--
-- Author: Ryan Miller (110b196f-3f0d-4890-969f-5571085039de). Reviewer/approver: Aneesh
-- (1ceaafde-4871-4411-9ef7-5432c7b4e080). Idempotent and reversible.

-- Up Migration

DO $phase2_interactive$
DECLARE
  v_prd_id       UUID := '45f17f84-bdb9-437e-bb6e-9c10ff5a2b37';
  v_author       TEXT := '110b196f-3f0d-4890-969f-5571085039de';
  v_reviewer     TEXT := '1ceaafde-4871-4411-9ef7-5432c7b4e080';
  v_skill        UUID := 'df2ab8a5-3a3e-4cbe-b685-1a3e6f0e6d73';
  v_now          TIMESTAMPTZ := '2026-08-05T15:00:00.000Z';
  v_epic_title   TEXT := 'Real-Time Interactive Agent Worker Tier (Phase 2)';
  v_bj           JSONB;
BEGIN
  SELECT backlog_json INTO v_bj FROM prds WHERE id = v_prd_id;
  IF v_bj IS NULL THEN
    RAISE NOTICE 'PRD % not found or has a null backlog_json; skipping Phase 2 seed', v_prd_id;
    RETURN;
  END IF;

  -- Guarded, idempotent append: only when the Phase 2 epic is not already present.
  IF NOT (v_bj->'epics' @> jsonb_build_array(jsonb_build_object('title', v_epic_title))) THEN
    UPDATE prds
    SET backlog_json = jsonb_set(
          jsonb_set(
            jsonb_set(
              backlog_json,
              '{epics}',
              (backlog_json->'epics') || $epic$
[
  {
    "title": "Real-Time Interactive Agent Worker Tier (Phase 2)",
    "priority": "Must Have",
    "description": "Provide a warm, low-latency interactive worker lane so interactive chat agents (Interview, ADR, Agent Home chat, Ask Apex, and the calendar/PRD/design assistants) execute off the web tier and stream near-real-time tokens back to users over the existing PostgreSQL notification and SSE spine, isolated from and fairly co-scheduled with the bounded background lane. This closes the Phase 1 gap in which interactive turns still ran in-process: dozens of background design-doc generations and many concurrent interactive conversations can now run at once without degrading each other.",
    "dependencies": [
      "Background Worker Execution",
      "Controlled Background Workflow Migration"
    ],
    "outOfScope": [
      "Model selection and skill authoring.",
      "Replacing the SSE transport with WebSockets or any new client transport.",
      "Guaranteeing an absolute latency independent of the shared Cursor upstream concurrency and rate quota.",
      "A dedicated interactive queue page or exact queue-position UI.",
      "A new human RBAC permission."
    ],
    "assumptions": [
      "The Phase 1 lifecycle, admission governor, fenced ingest, reaper, and shared Cursor execution core (FEAT-001..006) are deployed and stable and can be reused for the interactive lane.",
      "A warm long-lived Container App with a small reserved minimum-replica pool plus KEDA burst is sufficient to keep interactive first-token latency low under concurrent background load.",
      "A chat thread can be pinned to at most one in-flight interactive run at a time (already enforced by chat_threads.active_run_id), giving per-thread ordering for free.",
      "The event-driven run-termination decision (bounded per-tool deadlines) still governs wedged tool calls on the interactive worker; moving compute off-box does not make a stuck tool_call return.",
      "The Cursor upstream quota is shared across hosts, so the interactive lane improves isolation and latency but does not raise the account's ceiling."
    ],
    "successMetrics": [
      "Interactive first-token latency P95 stays within the configured SLO while at least 40 background runs execute concurrently.",
      "No interactive turn is starved by background admission: reserved interactive capacity is never consumed by the background lane.",
      "Disabling ai-runs-interactive routes all new interactive turns in-process while already-dispatched interactive runs drain."
    ],
    "features": [
      {
        "id": "FEAT-007",
        "title": "Warm Interactive Worker Pool and Dual-Lane Admission",
        "priority": "Must Have",
        "dependsOn": ["FEAT-003", "FEAT-004"],
        "description": "Provision a warm long-lived interactive Container App and an ai-runs-interactive Service Bus lane, and extend the admission governor with a reserved interactive lane, dual-lane fairness, and immediate saturation shedding so interactive turns never queue behind background work.",
        "featureFlag": { "name": "ai-runs-interactive" },
        "userTypes": ["Developer", "Product-Owner", "BA", "Manager", "Platform Admin"],
        "affectedPersonas": ["Developer", "Product-Owner", "BA", "Manager", "Platform Admin"],
        "outOfScope": [
          "Ephemeral scale-to-zero Jobs for the interactive lane (interactive uses a warm pool).",
          "A hard per-project interactive cap in Phase 2."
        ],
        "personaBehaviors": [
          {
            "behavior": "Provisions a warm long-lived Container App (min replicas for reserved capacity + KEDA burst on ai-runs-interactive depth), the ai-runs-interactive queue, and interactive runner identity/role; extends admission with a reserved interactive lane, dual-lane fairness, and saturation shedding.",
            "userTypes": ["Developer"]
          },
          {
            "behavior": "Interactive conversations stay responsive during heavy background generation because reserved interactive capacity cannot be consumed by background admission.",
            "userTypes": ["Product-Owner", "BA", "Manager"]
          }
        ],
        "items": [
          {
            "id": "TBI-009",
            "type": "TBI",
            "title": "Provision the warm interactive Container App, ai-runs-interactive lane, identity, and autoscale",
            "priority": "Must Have",
            "dependsOn": [],
            "parallelGroup": "interactive-infra",
            "description": "Provision ai-runs-interactive on the shared Service Bus namespace and a warm long-lived Container App with a reserved minimum replica count plus KEDA burst on interactive queue depth, an interactive runner managed identity with queue-scoped receive, Key Vault CURSOR_API_KEY access, image pull, the AiRun.Runner role, and the shared Azure Files mount; grant the web identity queue-scoped send on the interactive lane.",
            "definitionOfDone": [
              "The shared namespace contains ai-runs-interactive with poison-message handling.",
              "A warm Container App runs a reserved minimum replica count and bursts via KEDA on interactive queue depth without scaling to zero.",
              "The interactive runner can receive only from its lane, pull its image, mount the workspace, and read CURSOR_API_KEY from Key Vault.",
              "The web identity can send to the interactive lane without receiving from it."
            ],
            "technicalDependencies": [
              "Phase 1 secure worker infrastructure (FEAT-003) and load-test Container App pattern",
              "Shared Service Bus namespace and Azure Files mount",
              "Key Vault secret containing CURSOR_API_KEY"
            ],
            "nonFunctionalRequirements": [
              "Reserved warm replicas must remain resident so first-token latency is not gated by cold start.",
              "Queue and secret permissions must be scoped to least privilege.",
              "Infrastructure is additive and inert while ai-runs-interactive is disabled."
            ]
          },
          {
            "id": "TBI-010",
            "type": "TBI",
            "title": "Add the reserved interactive lane, dual-lane fair admission, and saturation shedding",
            "priority": "Must Have",
            "dependsOn": [],
            "parallelGroup": "interactive-infra",
            "description": "Extend the admission governor with a distinct interactive lane that holds reserved capacity the background lane can never consume, admits interactive work ahead of background work, and returns an immediate busy/fallback response when interactive demand exceeds interactive capacity instead of queuing indefinitely.",
            "definitionOfDone": [
              "Interactive and background in-flight counts are tracked and capped independently.",
              "Reserved interactive capacity is never allocated to background admission.",
              "Interactive demand over capacity yields an immediate busy response, not an unbounded queue wait.",
              "Concurrent-governor tests prove neither lane overshoots its cap and background load cannot starve interactive."
            ],
            "technicalDependencies": [
              "Phase 1 admission governor (FEAT-002) and agent_runs lifecycle (FEAT-001)",
              "PostgreSQL row locking with skip-locked semantics"
            ],
            "nonFunctionalRequirements": [
              "Dual-lane caps must hold under concurrent governors on multiple web instances.",
              "Interactive admission must add negligible latency to the turn hot path.",
              "Saturation shedding must be observable and fail closed to the in-process path."
            ]
          },
          {
            "id": "PBI-007",
            "type": "PBI",
            "title": "Guarantee Interactive Capacity Under Concurrent Background Load",
            "priority": "Must Have",
            "dependsOn": ["TBI-009", "TBI-010"],
            "parallelGroup": null,
            "testCaseCount": 4,
            "userStory": {
              "iWant": "interactive chat turns to have reserved worker capacity that background generation cannot consume",
              "soThat": "conversations stay responsive even while dozens of design docs generate",
              "persona": "Product-Owner"
            },
            "userTypes": ["Product-Owner"],
            "outOfScope": [
              "A hard per-project interactive cap.",
              "Exact interactive queue-position UI."
            ],
            "businessRules": ["BR-013", "BR-014"],
            "acceptanceCriteria": [
              {
                "given": "at least 40 background runs are executing and interactive capacity is free",
                "when": "a user starts an interactive turn",
                "then": "it is admitted to the interactive lane without waiting behind background work"
              },
              {
                "given": "background demand exceeds the background cap",
                "when": "admission runs",
                "then": "background work never consumes the reserved interactive capacity"
              },
              {
                "given": "interactive demand exceeds interactive capacity",
                "when": "a new interactive turn is started",
                "then": "the caller receives an immediate busy response and falls back to the in-process path rather than waiting indefinitely"
              },
              {
                "given": "two web instances admit concurrently across both lanes",
                "when": "they evaluate the same free capacity",
                "then": "neither lane overshoots its cap and each run is admitted at most once"
              }
            ],
            "nonFunctionalRequirements": {
              "security": "Admission operates on lane and project identifiers only and exposes no other project's run details.",
              "performance": "Interactive admission adds negligible latency; reserved warm capacity keeps first-token latency within the SLO under background load.",
              "accessibility": "A shed/busy interactive turn must surface an accessible, non-error waiting/fallback state rather than appearing frozen."
            }
          }
        ]
      },
      {
        "id": "FEAT-008",
        "title": "Bidirectional Interactive Session Relay",
        "priority": "Must Have",
        "route": "Existing chat surfaces",
        "dependsOn": ["FEAT-004", "FEAT-007"],
        "description": "Build the warm interactive session host and the streaming relay so a dispatched interactive turn runs the shared Cursor execution core on a warm worker, streams tokens/tools/progress back to the user in near real time over the existing PostgreSQL notification and SSE spine, preserves per-thread ordering and sticky affinity, cooperatively cancels, and replays cleanly on reconnect.",
        "featureFlag": { "name": "ai-runs-interactive" },
        "userTypes": ["Product-Owner", "BA", "Manager", "Developer"],
        "affectedPersonas": ["Product-Owner", "BA", "Manager", "Developer"],
        "outOfScope": [
          "Worker ownership of the user's SSE connection.",
          "A new client transport; the existing SSE stream is reused unchanged."
        ],
        "personaBehaviors": [
          {
            "behavior": "Builds the warm interactive session host (sticky per-thread Cursor Agent session with Agent.resume, warm grounded checkout reused across turns, batched token ingest, cooperative cancel) and per-thread ordered dispatch with reconnect-safe replay via pg NOTIFY.",
            "userTypes": ["Developer"]
          },
          {
            "behavior": "Experience near-real-time back-and-forth with any Apex chat agent: tokens stream as they are produced and turns complete over the same SSE stream, with no perceived change to how they chat.",
            "userTypes": ["Product-Owner", "BA", "Manager"]
          }
        ],
        "items": [
          {
            "id": "TBI-011",
            "type": "TBI",
            "title": "Build the warm interactive session host with token streaming ingest and cooperative cancel",
            "priority": "Must Have",
            "dependsOn": [],
            "parallelGroup": "interactive-relay",
            "description": "Build a long-lived session host that receives an interactive dispatch, runs the shared Cursor execution core with Agent.create/resume/send over a warm grounded checkout it materializes once per thread and reuses across turns, streams batched token/tool/progress events through the authenticated runner ingest, honors the bounded per-tool deadline, cooperatively cancels, and aborts on a fence conflict.",
            "definitionOfDone": [
              "A dispatched interactive turn runs on a warm replica and streams tokens back in near real time through ingest.",
              "The session reuses a warm grounded checkout across turns via Agent.resume rather than re-grounding each turn.",
              "Wedged tool calls terminate at their owner-side bounded deadline; the worker never hangs a turn open.",
              "Cancellation is acknowledged cooperatively and a stale dispatch identity is an immediate abort."
            ],
            "technicalDependencies": [
              "Shared Cursor execution core and worker host (FEAT-004)",
              "Event-driven run-termination bounded tool deadlines",
              "Pinned/warm local checkout materialization"
            ],
            "nonFunctionalRequirements": [
              "Token events must be batched to respect the PostgreSQL notification payload limit.",
              "The in-process fallback and interactive worker path must use one execution core.",
              "Warm-checkout reuse must not serve stale content past the pinned session grounding."
            ]
          },
          {
            "id": "TBI-012",
            "type": "TBI",
            "title": "Add per-thread ordered dispatch, sticky affinity, and reconnect-safe replay",
            "priority": "Must Have",
            "dependsOn": [],
            "parallelGroup": "interactive-relay",
            "description": "Ensure at most one in-flight interactive run per chat thread, dispatch turns in order, pin a thread to a warm replica for the life of the conversation via a session-affinity key (recovering by Agent.resume when a replica is lost), and fan out durable token/terminal events so a client reconnecting to any web instance replays by ordinal without duplication.",
            "definitionOfDone": [
              "A chat thread has at most one in-flight interactive run and turns apply in order.",
              "A thread is pinned to a warm replica; on replica loss the next turn resumes from persisted session state.",
              "Events fan out through the existing PostgreSQL notification path and replay by ordinal on reconnect to any instance.",
              "Reaper clocks recover lost interactive runs and free reserved capacity."
            ],
            "technicalDependencies": [
              "Existing PostgreSQL notification event spine and replayRunEvents",
              "chat_threads.active_run_id and cursor_agent_id",
              "Fenced ingest and lane-aware reaper (FEAT-004)"
            ],
            "nonFunctionalRequirements": [
              "Per-thread ordering must hold across horizontally scaled web instances with no sticky sessions.",
              "Reconnect replay must not duplicate or reorder delivered events.",
              "Interactive reaper clocks must be distinct from background and legacy in-process clocks."
            ]
          },
          {
            "id": "PBI-008",
            "type": "PBI",
            "title": "Stream Near-Real-Time Interactive Turns From the Worker",
            "priority": "Must Have",
            "dependsOn": ["TBI-011", "TBI-012"],
            "parallelGroup": null,
            "testCaseCount": 4,
            "userStory": {
              "iWant": "interactive agent turns to run on a warm worker and stream back in near real time",
              "soThat": "I get responsive back-and-forth with any Apex chat agent even under heavy load",
              "persona": "BA"
            },
            "userTypes": ["BA"],
            "outOfScope": [
              "Changing chat message semantics or the SSE contract.",
              "Mid-token editing of an in-flight turn beyond cooperative cancel and a new turn."
            ],
            "businessRules": ["BR-015", "BR-016", "BR-018"],
            "acceptanceCriteria": [
              {
                "given": "ai-runs-interactive is enabled and interactive capacity is available",
                "when": "a user sends a chat turn",
                "then": "the turn runs on a warm worker and tokens stream back over the existing SSE stream in near real time"
              },
              {
                "given": "a user sends two turns in the same thread in quick succession",
                "when": "the worker processes them",
                "then": "they are applied in order with at most one in-flight run for the thread"
              },
              {
                "given": "a client reconnects mid-turn to a different web instance",
                "when": "it resubscribes to the stream",
                "then": "it replays persisted events by ordinal without duplication and continues receiving live tokens"
              },
              {
                "given": "a warm replica holding a thread session is lost",
                "when": "the next turn is dispatched",
                "then": "the run resumes from persisted session state and reserved capacity is freed by the reaper"
              }
            ],
            "nonFunctionalRequirements": {
              "security": "Ingest requires AiRun.Runner and the current dispatch fence; prompts, snapshots, workspace content, and CURSOR_API_KEY are excluded from logs and Service Bus.",
              "performance": "First token streams within the configured SLO; tokens are batched to respect the notification payload limit.",
              "accessibility": "Streaming and terminal states remain announced to assistive technology and never rely on color alone."
            }
          }
        ]
      },
      {
        "id": "FEAT-009",
        "title": "Interactive Rollout, Latency SLO, and Worker Health",
        "priority": "Must Have",
        "dependsOn": ["FEAT-006", "FEAT-007", "FEAT-008"],
        "description": "Route interactive workflows (Interview, ADR, Agent Home chat, Ask Apex, and assistants) through the warm interactive lane behind a default-off ai-runs-interactive Feature Flag with fail-closed in-process fallback and drain-on-disable, and add interactive latency telemetry (first-token and turn P50/P95), lane utilization, warm-pool health, and an SLO alert.",
        "featureFlag": { "name": "ai-runs-interactive" },
        "userTypes": ["Product-Owner", "BA", "Manager", "Developer", "Platform Admin"],
        "affectedPersonas": ["Product-Owner", "BA", "Manager", "Developer", "Platform Admin"],
        "outOfScope": [
          "Automatically increasing the Cursor upstream quota.",
          "A dedicated interactive queue page or exact queue position."
        ],
        "personaBehaviors": [
          {
            "behavior": "Routes interactive agent turns behind ai-runs-interactive (per-project, fail-closed), preserving in-process fallback and drain-on-disable; emits interactive latency, lane utilization, and warm-pool health telemetry with an SLO alert.",
            "userTypes": ["Developer"]
          },
          {
            "behavior": "Controls the interactive rollout and kill switch and reads first-token/turn latency and warm-pool health to tune reserved capacity.",
            "userTypes": ["Platform Admin"]
          }
        ],
        "items": [
          {
            "id": "TBI-013",
            "type": "TBI",
            "title": "Route interactive workflows behind ai-runs-interactive with fail-closed fallback",
            "priority": "Must Have",
            "dependsOn": [],
            "parallelGroup": "interactive-ops",
            "description": "Add a thin interactive routing seam to the chat agent entry point so Interview, ADR, Agent Home chat, Ask Apex, and assistant turns evaluate ai-runs-interactive per project at dispatch, route enabled turns to the warm lane, fail closed to the existing in-process path on disable or evaluation error, and drain already-dispatched interactive runs on disable.",
            "definitionOfDone": [
              "Interactive workflows are independently routable per project and default off.",
              "Evaluation failure or a disabled flag routes turns in-process with no worker dispatch.",
              "Disabling the flag drains already-dispatched interactive runs while new turns go in-process.",
              "Flag actions remain auditable through existing Platform Admin controls."
            ],
            "technicalDependencies": [
              "Existing Feature Flag service and Phase 1 routing seam (FEAT-005/FEAT-006)",
              "Chat agent service entry point"
            ],
            "nonFunctionalRequirements": [
              "Flag evaluation failure must fail closed to in-process execution.",
              "Flag changes must apply to new turns without redeployment.",
              "Already-dispatched interactive runs must not be terminated by disabling the flag."
            ]
          },
          {
            "id": "TBI-014",
            "type": "TBI",
            "title": "Add interactive latency telemetry, lane utilization, warm-pool health, and the SLO alert",
            "priority": "Must Have",
            "dependsOn": [],
            "parallelGroup": "interactive-ops",
            "description": "Emit first-token and turn P50/P95 latency, interactive lane utilization vs reserved capacity, saturation-shed counts, warm-pool replica health, and reconnect-replay counts through the existing worker-tier telemetry module and agent-health endpoint, with an alert when first-token P95 breaches the configured SLO or reserved capacity is exhausted.",
            "definitionOfDone": [
              "First-token and turn latency P50/P95 are emitted for the interactive lane.",
              "Interactive utilization, shed counts, and warm-pool health are reported and safe-logged.",
              "Agent health reports interactive saturation and SLO status.",
              "An SLO breach or reserved-capacity exhaustion raises an alert."
            ],
            "technicalDependencies": [
              "Phase 1 worker-tier telemetry module and agent-health endpoint (FEAT-006)",
              "Interactive lifecycle timestamps and lane counters"
            ],
            "nonFunctionalRequirements": [
              "Telemetry must never include prompt, snapshot, workspace content, or CURSOR_API_KEY.",
              "Metrics must expose P50/P95 first-token and turn latency.",
              "Alerts must be actionable and tied to the configured SLO and reserved-capacity values."
            ]
          },
          {
            "id": "PBI-009",
            "type": "PBI",
            "title": "Roll Out Interactive Workers Safely With a Latency SLO",
            "priority": "Must Have",
            "dependsOn": ["TBI-013", "TBI-014"],
            "parallelGroup": null,
            "testCaseCount": 4,
            "userStory": {
              "iWant": "to roll out the interactive worker lane per project with a latency SLO and an immediate kill switch",
              "soThat": "I can validate responsiveness, tune reserved capacity, and revert to the proven in-process path when needed",
              "persona": "Platform Admin"
            },
            "userTypes": ["Platform Admin"],
            "outOfScope": [
              "Exact interactive queue-position UI.",
              "Automatically increasing Cursor upstream quota."
            ],
            "businessRules": ["BR-017", "BR-019"],
            "acceptanceCriteria": [
              {
                "given": "ai-runs-interactive is enabled for one internal project",
                "when": "users interact with a chat agent there",
                "then": "turns use the warm lane and first-token latency stays within the configured SLO under background load"
              },
              {
                "given": "flag evaluation fails or the Platform Admin disables the flag",
                "when": "a new interactive turn starts",
                "then": "it safely uses the existing in-process path and no new worker dispatch is created"
              },
              {
                "given": "interactive runs are already dispatched when the flag is disabled",
                "when": "those workers keep reporting",
                "then": "they drain normally while subsequent turns use the in-process path"
              },
              {
                "given": "first-token P95 breaches the SLO or reserved capacity is exhausted",
                "when": "telemetry evaluates the interactive lane",
                "then": "an alert is raised and agent health reports interactive saturation"
              }
            ],
            "nonFunctionalRequirements": {
              "security": "Rollout reuses existing Platform Admin flag controls and audit; telemetry excludes project-confidential content and secrets.",
              "performance": "Operational metrics report first-token and turn P50/P95 and utilization against reserved interactive capacity.",
              "accessibility": "Rollout and fallback states surface through existing accessible progress and status surfaces."
            }
          }
        ]
      }
    ]
  }
]
$epic$::jsonb,
              true),
            '{businessRules}',
            (backlog_json->'businessRules') || $br$
[
  { "id": "BR-013", "rule": "The interactive lane holds reserved warm capacity that background admission can never consume; interactive runs never queue behind background work.", "appliesTo": "Guarantee Interactive Capacity Under Concurrent Background Load" },
  { "id": "BR-014", "rule": "When interactive demand exceeds interactive capacity, callers receive an immediate busy response and fall back to the in-process path rather than waiting indefinitely; interactive work is not queued unbounded.", "appliesTo": "Guarantee Interactive Capacity Under Concurrent Background Load" },
  { "id": "BR-015", "rule": "A chat thread has at most one in-flight interactive run at a time, and interactive turns for a thread are dispatched and applied in order.", "appliesTo": "Stream Near-Real-Time Interactive Turns From the Worker" },
  { "id": "BR-016", "rule": "Every interactive token, progress, and terminal event is persisted and fanned out through the existing PostgreSQL notification and SSE spine; the worker never owns the user's SSE connection.", "appliesTo": "Stream Near-Real-Time Interactive Turns From the Worker" },
  { "id": "BR-017", "rule": "When ai-runs-interactive is disabled or evaluation fails, new interactive turns use the existing in-process path while already-dispatched interactive runs drain.", "appliesTo": "Roll Out Interactive Workers Safely With a Latency SLO" },
  { "id": "BR-018", "rule": "Every interactive worker callback carries the current dispatch fence; stale identities are rejected and the stale worker aborts.", "appliesTo": "Stream Near-Real-Time Interactive Turns From the Worker" },
  { "id": "BR-019", "rule": "Interactive telemetry and structured logs exclude prompt, snapshot, workspace content, and CURSOR_API_KEY.", "appliesTo": "Roll Out Interactive Workers Safely With a Latency SLO" }
]
$br$::jsonb,
            true),
          '{implementationPhases}',
          (backlog_json->'implementationPhases') || $ph$
[
  {
    "epics": ["Real-Time Interactive Agent Worker Tier (Phase 2)"],
    "phase": 4,
    "rationale": "The warm interactive lane, dual-lane fairness, streaming session relay, and interactive rollout depend on the fully fenced, observable, bounded background worker path from Phase 1; building them last reuses that foundation to deliver near-real-time interactive agents without reworking lifecycle, admission, ingest, or reaper invariants."
  }
]
$ph$::jsonb,
          true),
        content = content || $prdmd$


---

## Phase 2 — Real-Time Interactive Agent Worker Tier

Phase 1 bounds and isolates **background** generation (PRD, Design Doc, validation, test cases). Phase 2 closes the remaining gap by moving **interactive** agents (Interview, ADR, Agent Home chat, Ask Apex, and the calendar/PRD/design assistants) onto a warm, low-latency worker lane so users experience near-real-time back-and-forth even while tens of background generations run.

### Solution

Add a warm long-lived Container App on a new `ai-runs-interactive` Service Bus lane with a small reserved minimum-replica pool plus KEDA burst. Extend the admission governor into two lanes: background keeps its bounded cap (8–12) while interactive holds **reserved** capacity the background lane can never consume and **sheds to in-process** immediately when saturated rather than queuing. Interactive turns are dispatched per-thread in order (one in-flight run per thread), run the shared Cursor execution core on a sticky warm replica that reuses a grounded checkout across turns via `Agent.resume`, and stream batched tokens/tools/progress back over the existing PostgreSQL notification → SSE spine. Wedged tool calls are still terminated by the event-driven bounded per-tool deadline. Rollout is gated by a default-off `ai-runs-interactive` Feature Flag with fail-closed in-process fallback, drain-on-disable, and a first-token latency SLO with alerting.

### New backlog (Epic: Real-Time Interactive Agent Worker Tier — Phase 2)

- **FEAT-007 — Warm Interactive Worker Pool and Dual-Lane Admission** (TBI-009, TBI-010, PBI-007)
- **FEAT-008 — Bidirectional Interactive Session Relay** (TBI-011, TBI-012, PBI-008)
- **FEAT-009 — Interactive Rollout, Latency SLO, and Worker Health** (TBI-013, TBI-014, PBI-009)

Business rules BR-013…BR-019 govern reserved capacity, saturation shedding, per-thread ordering, durable streaming fan-out, fencing, drain-on-disable, and telemetry sanitization.

### Feature Flag

- **Flag required:** Yes
- **Flag name:** `ai-runs-interactive`
- **Rollout sequence:** Enable one low-risk interactive workflow (e.g. Ask Apex) for one internal project, validate the first-token SLO under background load, widen across interactive workflows, then broaden to all projects.
- **Behavior when disabled:** New interactive turns execute in-process; already-dispatched interactive runs drain.

### Out of Scope (Phase 2)

- Raising the shared Cursor upstream concurrency/rate quota (isolation improves latency, not the ceiling).
- Replacing the SSE transport, a dedicated interactive queue page, exact queue position, or a new human RBAC permission.
$prdmd$,
        updated_at = v_now
    WHERE id = v_prd_id;

    RAISE NOTICE 'Phase 2 epic, business rules, phase, and PRD markdown appended to PRD %', v_prd_id;
  ELSE
    RAISE NOTICE 'Phase 2 epic already present on PRD %; skipping backlog/content append', v_prd_id;
  END IF;

  -- ── Insert the three Phase 2 design docs (feature_index 6, 7, 8) ───────────────────────────
  INSERT INTO design_docs (
    id, prd_id, project, chat_thread_id, design_prototype_id, feature_index,
    author_id, title, model, design_content, tech_spec_content, assumptions_content,
    status, reviewer_id, reviewed_at, validation_score, skill_settings_id, created_at, updated_at
  )
  VALUES
  (
    'a1c2e3f4-0b1d-4e2f-8a3b-6c7d8e9f0016',
    v_prd_id, 'Apex', NULL, NULL, 6,
    v_author,
    'Warm Interactive Worker Pool and Dual-Lane Admission',
    'claude-opus-4-8',
    $design6$# Design — Warm Interactive Worker Pool and Dual-Lane Admission

> **PRD slug:** `move-ai-agent-execution-to-a-bounded-worker-tier-phase-1` (Phase 2) | **Priority:** Must Have | **Feature flag:** `ai-runs-interactive`
> **Parent Epic:** Real-Time Interactive Agent Worker Tier (Phase 2) | **Affected personas:** Developer, Product-Owner, BA, Manager, Platform Admin

## Feature Summary

Phase 1 moved background generation off the web tier but left interactive agents (Interview, ADR, Agent Home chat, Ask Apex, assistants) running in-process, so heavy background load still competes with conversations for the web event loop and the shared Cursor quota. This Feature provisions a **warm long-lived interactive Container App** on a new `ai-runs-interactive` Service Bus lane and extends the Phase 1 admission governor into a **dual-lane** governor: background keeps its bounded cap while interactive holds **reserved** warm capacity that background admission can never consume. When interactive demand exceeds interactive capacity, callers get an immediate busy response and fall back in-process rather than waiting. This is the substrate that lets ~40 background runs and many live conversations coexist without degradation.

**Work items:** TBI-009 (warm Container App + `ai-runs-interactive` lane + identity + autoscale), TBI-010 (reserved lane + dual-lane fair admission + saturation shedding), PBI-007 (Guarantee Interactive Capacity Under Concurrent Background Load).

## Scope and Out-of-Scope

**In scope:** the `ai-runs-interactive` queue on the shared namespace; a warm Container App with a reserved minimum replica count plus KEDA burst on interactive depth (never scale-to-zero); an interactive runner managed identity (queue-scoped receive, Key Vault `CURSOR_API_KEY`, image pull, `AiRun.Runner` role); web identity queue-scoped send; and a dual-lane admission extension with reserved interactive capacity and immediate saturation shedding.

**Out of scope:** ephemeral scale-to-zero Jobs for interactive work (that is the background lane); a hard per-project interactive cap in Phase 2; the session host and streaming relay (FEAT-008); routing, flag, and telemetry (FEAT-009).

## Target Surface

**Primary surface:** Backend + infrastructure (Terraform in `infra/`) plus admission-service changes; no client change. **Experience note:** the only user-visible effect is that conversations stay responsive during heavy background generation.

## Access Control

Human trigger/observe of chat is unchanged and keeps existing permissions. The interactive runner identity receives only from `ai-runs-interactive` and holds the `AiRun.Runner` role for ingest; admission runs as an Apex system service at global scope. No new human RBAC permission.

**Feature flag:** `ai-runs-interactive` (default off). **When disabled:** interactive turns run in-process; the interactive Container App idles at its reserved minimum and admission simply is not consulted for interactive turns.

## Acceptance Criteria (PBI-007)

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | ≥40 background runs executing, interactive capacity free | A user starts an interactive turn | It is admitted to the interactive lane without waiting behind background work |
| (b) Isolation | Background demand exceeds the background cap | Admission runs | Background never consumes the reserved interactive capacity |
| (c) Saturation | Interactive demand exceeds interactive capacity | A new interactive turn starts | The caller gets an immediate busy response and falls back in-process, not an unbounded wait |
| (d) Concurrency | Two web instances admit across both lanes | They evaluate the same free capacity | Neither lane overshoots its cap; each run admitted at most once |

## UI/UX

Not applicable — infrastructure and admission only. A shed/busy interactive turn surfaces through the existing accessible progress/status surfaces (FEAT-009 owns labels).

## Technical Specification

See the tech spec for the Terraform module, dual-lane admission transaction, reserved-capacity math, and the verification matrix.
$design6$,
    $tech6$# Technical Specification — Warm Interactive Worker Pool and Dual-Lane Admission

> **Owning layer:** `infra/` (Terraform) + `src/server/services/admissionGovernorService.ts` | **Surface:** Backend + infrastructure
> **Verification builds:** `terraform -chdir=infra validate` / `plan`; `npx tsc -p tsconfig.server.json --noEmit`

## System Boundary and Owning Layer

A new `infra/ai-runs-interactive.tf` (+ `infra/ai-runs-interactive-entra.tf` if a distinct role is chosen) provisions the `ai-runs-interactive` queue on the **shared** Service Bus namespace and a warm `azurerm_container_app` (not a Job) with `min_replicas >= reserved interactive capacity` and a KEDA `azure-servicebus` scale rule for burst above the warm floor. The admission change extends the Phase 1 `admissionGovernorService.ts` from a single cap to two lane caps.

**Rationale:** interactive work needs a **resident** process to avoid cold-start on first token, so a warm Container App is used instead of the background lane's ephemeral Job (the worker-tier ADR specifies exactly this — "phase 1 uses an ephemeral Container Apps Job; phase 2 uses a warm long-lived Container App"). Reserved-vs-background isolation is a property of admission, which already owns the DB-authoritative counts, so the split lives in the governor, not in KEDA.

## Security Enforcement

- **Authorization:** queue-scoped Azure RBAC — interactive runner identity gets `Azure Service Bus Data Receiver` on `ai-runs-interactive` only; the web identity gets `Data Sender`. `CURSOR_API_KEY` is resolved from Key Vault by the runner MI, never an app setting or message payload. No new human permission key.
- **Scope layer:** Azure control plane (entity-scoped role assignments to the queue, Key Vault, registry) plus the FEAT-008 ingest fence at runtime.
- **Sensitive data:** dispatch messages remain `{ runId, dispatchMessageId }` only (BR-006 reused); logs carry `runId`/`dispatchMessageId`/`project`/`lane` only.

## Architecture and Approach

### Dual-lane admission (TBI-010)

One `db.transaction()` computes both lane occupancies from `agent_runs`:

- `backgroundInFlight = count(status IN ('dispatched','running') AND lane='ai-runs-background')`
- `interactiveInFlight = count(status IN ('dispatched','running') AND lane='ai-runs-interactive')`

Caps come from a single config source shared with KEDA: `AI_RUNS_BACKGROUND_INFLIGHT_LIMIT` (8–12) and `AI_RUNS_INTERACTIVE_RESERVED` (reserved warm slots) + `AI_RUNS_INTERACTIVE_BURST_MAX`. Background admission may use only up to its own cap and **cannot** borrow interactive reserved slots (BR-013). Interactive admission fills reserved slots first, then burst up to `INTERACTIVE_BURST_MAX`; beyond that it returns `AdmissionResult{ shed: true }` and the caller routes in-process (BR-014) rather than enqueuing. Selection uses `FOR UPDATE SKIP LOCKED`, so concurrent governors on multiple web instances never double-admit and neither lane overshoots (PBI-007 d). Interactive fairness orders by fewest in-flight interactive runs per project, then oldest queued, then stable id — but interactive turns are effectively dispatched immediately (reserved warm capacity), so ordering rarely binds.

### Warm Container App (TBI-009)

`azurerm_container_app` with `min_replicas = AI_RUNS_INTERACTIVE_RESERVED`, `max_replicas = AI_RUNS_INTERACTIVE_BURST_MAX`, a `custom` KEDA `azure-servicebus` scale rule on `ai-runs-interactive` queue depth, the interactive runner user-assigned MI, the shared Azure Files mount (for warm grounded checkouts, FEAT-008), and Key Vault + ACR access — mirroring the load-test Container App shape but keeping a non-zero floor.

## Data and Contracts

| Method | Route | Shape | Auth |
|--------|-------|-------|------|
| — | Internal `admissionGovernor.runCycle(lane)` | `AdmissionResult{ admitted, shed, laneInFlight, laneCap }` | Apex system service |
| PUT (outbound) | Service Bus → `ai-runs-interactive` | `{ runId, dispatchMessageId }` | Managed identity (send) |

**Schema:** no new columns — reuses the Phase 1 `agent_runs.lane` (value `ai-runs-interactive`) and lifecycle indexes; adds a partial index on `(lane, status)` for the interactive in-flight count if not already covered.

## Testing Strategy

- **Unit:** reserved-capacity math (background cannot consume reserved; interactive burst caps; shed above burst).
- **Integration (real PG):** concurrent dual-lane governors never overshoot either cap; a saturated background lane never starves interactive; interactive shed returns `shed:true`.
- **Terraform:** `plan` shows `min_replicas>=reserved`, a burst scale rule, queue-scoped receiver, and a warm (non-zero) floor.

## Verification Test Matrix

| ID | Layer | Assert | Linked |
|----|-------|--------|--------|
| VT-01 | Integration | Interactive admitted immediately with 40 background in-flight | PBI-007 (a) |
| VT-02 | Integration | Background never allocated a reserved interactive slot | PBI-007 (b) |
| VT-03 | Integration | Interactive over burst → `shed:true`, no enqueue | PBI-007 (c) |
| VT-04 | Integration | Concurrent governors: no lane overshoot, admit-once | PBI-007 (d) |
| VT-05 | Terraform | Warm Container App floor + burst rule + queue-scoped RBAC | TBI-009 |

## Rollback and Deployment

Additive Terraform and an additive admission branch gated by `ai-runs-interactive` (default off). Rollback disables the flag (interactive routes in-process) and, if needed, `terraform destroy` the interactive module after runs drain.

## Implementation Plan

- [ ] S1 — `ai-runs-interactive` queue + warm Container App + interactive MI/RBAC in `infra/`.
- [ ] S2 — Config source of truth for background cap + interactive reserved/burst shared with KEDA.
- [ ] S3 — Extend `admissionGovernorService` to dual-lane counts, reserved isolation, and shed.
- [ ] S4 — Integration + Terraform verification.
$tech6$,
    $assume6$# Assumptions & Unresolved Items — Warm Interactive Worker Pool and Dual-Lane Admission

## Unresolved Items

- ⚠ **Reserved vs burst sizing:** the initial `AI_RUNS_INTERACTIVE_RESERVED` (warm floor) and `AI_RUNS_INTERACTIVE_BURST_MAX` are not fixed. Recommended starting point: reserve = expected steady concurrent conversations (e.g. 4–6), burst = 2–3× reserved, tuned by FEAT-009 first-token telemetry. Blocks the Container App floor and the governor caps.
- ⚠ **Interactive runner role reuse:** whether interactive reuses the `AiRun.Runner` Entra role (scoped receive to both queues) or a distinct `AiRun.InteractiveRunner`. Default: reuse `AiRun.Runner`, add a queue-scoped receiver assignment on `ai-runs-interactive`.
- ⚠ **KEDA scaler auth on the shared namespace:** inherits the Phase 1 open item (MI-based scale rule with `azurerm ≥ 4.73` vs scoped `manage` SAS for queue-length polling).

## Assumptions Accepted

- **Warm pool, not Jobs:** interactive uses a resident Container App with a non-zero floor so first token is not gated by cold start — per the worker-tier ADR Phase 2 decision.
- **Reserved capacity is an admission property:** isolation between lanes is enforced by the DB governor counts, not by KEDA, so background can never consume reserved interactive slots (BR-013).
- **Immediate shed, not unbounded queue:** interactive over capacity sheds to in-process (BR-014); interactive work is latency-sensitive and must not wait behind a queue.
- **`agent_runs.lane` carries `ai-runs-interactive`:** reuses the Phase 1 lifecycle/lane column and indexes; no new queue table.
$assume6$,
    'approved', v_reviewer, v_now, 96, v_skill, v_now, v_now
  ),
  (
    'a1c2e3f4-0b1d-4e2f-8a3b-6c7d8e9f0017',
    v_prd_id, 'Apex', NULL, NULL, 7,
    v_author,
    'Bidirectional Interactive Session Relay',
    'claude-opus-4-8',
    $design7$# Design — Bidirectional Interactive Session Relay

> **PRD slug:** `move-ai-agent-execution-to-a-bounded-worker-tier-phase-1` (Phase 2) | **Priority:** Must Have | **Feature flag:** `ai-runs-interactive`
> **Parent Epic:** Real-Time Interactive Agent Worker Tier (Phase 2) | **Affected personas:** Product-Owner, BA, Manager, Developer

## Feature Summary

This Feature makes interactive agents feel real time. A dispatched interactive turn runs the **shared Cursor execution core** on a **warm** replica that holds the thread's `Agent` session (via `Agent.resume`) and a grounded checkout it materializes once per thread and reuses across turns, then streams batched token/tool/progress events back to the user over the **existing** PostgreSQL notification → SSE spine. Per-thread ordering (one in-flight run per thread), sticky affinity, cooperative cancel, fencing, and reconnect-safe replay give a responsive back-and-forth with any Apex chat agent without the worker ever owning the user's SSE socket.

**Work items:** TBI-011 (warm session host + token streaming ingest + cooperative cancel), TBI-012 (per-thread ordered dispatch + sticky affinity + reconnect replay), PBI-008 (Stream Near-Real-Time Interactive Turns From the Worker).

## Scope and Out-of-Scope

**In scope:** the warm interactive session host; batched token/tool/progress streaming through the authenticated runner ingest; warm grounded-checkout reuse across turns via `Agent.resume`; bounded per-tool deadline enforcement on the worker; cooperative cancel + fence abort; per-thread single-in-flight ordering; sticky thread→replica affinity with resume-on-loss; durable fan-out and ordinal replay.

**Out of scope:** worker ownership of the SSE connection; a new client transport; mid-token editing of an in-flight turn (beyond cancel + new turn); dual-lane admission/infra (FEAT-007); routing/flag/telemetry (FEAT-009).

## Target Surface

**Primary surface:** Full-stack, backend/worker-heavy. The only client-relevant behavior is that streaming and terminal states render over the existing chat SSE stream unchanged; no new component.

## Access Control

Chat trigger keeps existing permissions. Ingest requires the `AiRun.Runner` role and the current dispatch fence (BR-018). No new human permission.

**Feature flag:** `ai-runs-interactive` (default off). **When disabled:** turns run in-process; already-dispatched interactive runs drain.

## Acceptance Criteria (PBI-008)

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | Flag enabled, interactive capacity free | A user sends a chat turn | The turn runs on a warm worker and tokens stream back over the existing SSE stream in near real time |
| (b) Ordering | Two quick turns in one thread | The worker processes them | Applied in order; at most one in-flight run per thread |
| (c) Reconnect | Client reconnects mid-turn to another instance | It resubscribes | Replays persisted events by ordinal without duplication and keeps receiving live tokens |
| (d) Replica loss | Warm replica holding the session is lost | Next turn is dispatched | Run resumes from persisted session state; reaper frees reserved capacity |

## UI/UX

No new routes or components. Existing chat progress/streaming surfaces render `queued`/`dispatched`/streaming/terminal states from the same `useChatStream` consumer; accessibility and `data-testid`s are unchanged. Vocabulary/labels are owned by FEAT-009.

## Technical Specification

See the tech spec for the session host, ingest event batching, ordering/affinity, and reconnect replay.
$design7$,
    $tech7$# Technical Specification — Bidirectional Interactive Session Relay

> **Owning layer:** `src/server/services/` + `runner/` (interactive host) + `src/server/routes/` (ingest) | **Surface:** Full stack (backend/worker-heavy)
> **Verification builds:** `npx tsc -p tsconfig.server.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit`

## System Boundary and Owning Layer

Reuses the Phase 1 shared Cursor execution core (extracted from `chatAgentService.ts`), the fenced runner ingest (`aiRunIngestService` / `aiRunsInternal.ts`), and the durable fan-out (`pgNotifyService.notifyRunEvent` / `replayRunEvents`). New work: a **warm session host** in `runner/` that keeps a resident process, holds per-thread `Agent` sessions, and streams; interactive reaper clocks in `agentRunReaperService.ts`; and an ordered per-thread dispatch seam.

## Security Enforcement

- **Auth:** ingest via `requireAiRunnerAuth` (`AiRun.Runner` MI + dispatch fence), identical to Phase 1. Stale `dispatchMessageId` → `409 AI_RUN_DISPATCH_MISMATCH`, worker aborts (BR-018).
- **Scope layer:** route middleware + service-layer fence and project/thread scope.
- **Sensitive data:** batched token events persist sanitized text; prompt/snapshot/workspace/secret never logged or placed on Service Bus (BR-016/BR-019).

## Architecture and Approach

### Warm session host (TBI-011)

The resident host receives an interactive dispatch `{ runId, dispatchMessageId }`, loads the frozen snapshot, and for the thread either creates (`Agent.create`) or resumes (`Agent.resume` by `chat_threads.cursor_agent_id`) the session against a **warm grounded checkout** materialized once per thread on the shared Azure Files mount and reused across turns (avoiding per-turn re-grounding latency). It runs the shared execution core and streams tokens/tools/progress as **batched** ingest events (coalescing tokens to respect the ~8 KB PostgreSQL `NOTIFY` payload limit called out in the ADR). Wedged tool calls terminate at the owner-side bounded deadline (event-driven run-termination ADR) so a turn never hangs open. Cancellation is cooperative: ingest responses carry `cancelRequested`; the host aborts the SDK run and posts `cancel_ack`. A fence conflict is an immediate abort before further writes.

### Ordering, affinity, replay (TBI-012)

Per-thread ordering reuses `chat_threads.active_run_id`: a new interactive turn enqueues only when the thread has no in-flight run, else it is applied after the current run terminates (BR-015). Sticky affinity pins a thread to a warm replica via a session-affinity key so `Agent.resume` reuses in-memory session context; on replica loss the next turn resumes from persisted session state (`cursor_agent_id` + run events) and the reaper's interactive clock frees the reserved slot. Durable fan-out is unchanged: events persist to `agent_run_events` and fan out via `pg_notify`; a client reconnecting to any instance calls `replayRunEvents` by `ordinal` (no duplication, BR-016, PBI-008 c).

## Data and Contracts

| Method | Route | Shape | Auth |
|--------|-------|-------|------|
| POST | `/api/internal/ai-runs/:projectId/:runId/ingest` | `{ dispatchMessageId, kind: 'token'|'progress'|'tool'|'cancel_ack'|'terminal', seq, batch?, detail?, status? }` | `requireAiRunnerAuth` |
| — | Fence conflict | `409 AI_RUN_DISPATCH_MISMATCH` | — |

**Schema:** no new columns — reuses Phase 1 lifecycle/fence/lane on `agent_runs`, `agent_run_events` for durable tokens, and `chat_threads.active_run_id`/`cursor_agent_id`. Interactive reaper clocks are env-tunable keys distinct from background and legacy.

## Testing Strategy

- **Unit:** token batching respects payload limits; cancel_ack path; fence rejection; per-thread single-in-flight guard.
- **Integration (real PG):** stream fans out and replays by ordinal without dupes; resume-on-replica-loss; interactive reaper frees reserved capacity; legacy/background rows untouched by interactive clocks.
- **E2E (Playwright):** enabled project — a chat turn streams tokens live, a second quick turn applies in order, reconnect mid-turn replays and continues.

## Verification Test Matrix

| ID | Layer | Assert | Linked |
|----|-------|--------|--------|
| VT-01 | Integration | Warm turn streams batched tokens via ingest → SSE | PBI-008 (a) |
| VT-02 | Integration | Two quick turns apply in order; one in-flight per thread | PBI-008 (b) |
| VT-03 | Integration | Reconnect replays by ordinal, no duplication | PBI-008 (c) |
| VT-04 | Integration | Replica loss → resume; reaper frees reserved slot | PBI-008 (d) |
| VT-05 | Unit | Stale dispatch → 409, host aborts | BR-018 |

## Rollback and Deployment

Additive; gated by `ai-runs-interactive` (default off). Disable drains dispatched interactive runs; the ingest plane and reaper stay deployed so draining completes.

## Implementation Plan

- [ ] S1 — Warm interactive session host (`Agent.resume`, warm checkout reuse, batched streaming, bounded tool deadline, cancel/fence).
- [ ] S2 — Per-thread ordered dispatch + sticky affinity + resume-on-loss.
- [ ] S3 — Interactive reaper clocks + durable replay verification.
- [ ] S4 — E2E streaming/ordering/reconnect.
$tech7$,
    $assume7$# Assumptions & Unresolved Items — Bidirectional Interactive Session Relay

## Unresolved Items

- ⚠ **Token batching cadence vs latency:** the coalescing window (e.g. flush every N tokens or ~50–100 ms) that balances near-real-time feel against the PostgreSQL `NOTIFY` payload limit is not fixed. Blocks the streaming ingest tuning; recommend a small time+size flush with backpressure.
- ⚠ **Sticky affinity mechanism:** whether thread→replica stickiness is a soft hint (affinity key + resume-on-loss) or an enforced routing key. Default: soft affinity with `Agent.resume` recovery, accepting an occasional re-ground on replica loss.
- ⚠ **Warm-checkout refresh policy:** when a long-lived thread's grounded checkout is refreshed relative to new commits. Default: pin for the session; refresh on explicit re-ground or new-branch selection.

## Assumptions Accepted

- **Reuse the Phase 1 execution core, ingest, fan-out, and reaper:** the interactive path adds a warm host and clocks, not a new spine — avoiding drift with the background path.
- **Per-thread ordering is free from `active_run_id`:** one in-flight run per thread already holds (BR-015).
- **Bounded tool deadlines still apply on the worker:** moving compute off-box does not make a wedged `tool_call` return; the event-driven run-termination decision governs it.
- **Worker never owns the SSE socket:** events flow through `pg_notify` → SSE and replay by ordinal (BR-016).
$assume7$,
    'approved', v_reviewer, v_now, 97, v_skill, v_now, v_now
  ),
  (
    'a1c2e3f4-0b1d-4e2f-8a3b-6c7d8e9f0018',
    v_prd_id, 'Apex', NULL, NULL, 8,
    v_author,
    'Interactive Rollout, Latency SLO, and Worker Health',
    'claude-opus-4-8',
    $design8$# Design — Interactive Rollout, Latency SLO, and Worker Health

> **PRD slug:** `move-ai-agent-execution-to-a-bounded-worker-tier-phase-1` (Phase 2) | **Priority:** Must Have | **Feature flag:** `ai-runs-interactive`
> **Parent Epic:** Real-Time Interactive Agent Worker Tier (Phase 2) | **Affected personas:** Product-Owner, BA, Manager, Developer, Platform Admin

## Feature Summary

This Feature makes the interactive lane safe to turn on. It routes interactive workflows (Interview, ADR, Agent Home chat, Ask Apex, assistants) behind a default-off `ai-runs-interactive` Feature Flag with **fail-closed** in-process fallback and **drain-on-disable**, and it adds interactive-specific telemetry — first-token and turn P50/P95 latency, interactive lane utilization vs reserved capacity, saturation-shed counts, warm-pool replica health, and reconnect-replay counts — with an alert when first-token P95 breaches the configured SLO or reserved capacity is exhausted.

**Work items:** TBI-013 (interactive routing + fail-closed fallback), TBI-014 (interactive latency telemetry + warm-pool health + SLO alert), PBI-009 (Roll Out Interactive Workers Safely With a Latency SLO).

## Scope and Out-of-Scope

**In scope:** a thin interactive routing seam at the chat agent entry point evaluating `ai-runs-interactive` per project; fail-closed fallback and drain-on-disable; interactive latency/utilization/health telemetry via the Phase 1 worker-tier telemetry module and agent-health endpoint; an SLO/reserved-capacity alert.

**Out of scope:** raising the Cursor upstream quota; a dedicated interactive queue page or exact queue position; a new human RBAC permission; the warm pool/admission (FEAT-007) and the session relay (FEAT-008).

## Target Surface

**Primary surface:** Full-stack, backend/ops-heavy. The user-visible change is only that interactive turns route to the warm lane when enabled; rollout reuses Platform Admin → Feature Flags.

## Access Control

Rollout uses the existing Super-Admin-gated flag controls and audit. Generation/chat visibility stays project-scoped. No new human permission.

**Feature flag:** `ai-runs-interactive` (default off). **When disabled or on eval error:** interactive turns run in-process (fail-closed); dispatched interactive runs drain (BR-017).

## Acceptance Criteria (PBI-009)

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | Flag enabled for one internal project | Users chat with an agent there | Turns use the warm lane and first-token latency stays within the SLO under background load |
| (b) Fail-closed | Flag eval fails or admin disables | A new interactive turn starts | It uses the in-process path; no worker dispatch created |
| (c) Drain | Interactive runs dispatched when disabled | Those workers keep reporting | They drain while subsequent turns go in-process |
| (d) SLO alert | First-token P95 breaches SLO or reserved capacity exhausted | Telemetry evaluates the lane | An alert fires and agent health reports interactive saturation |

## UI/UX

No new page. Interactive states render through the existing accessible chat progress/status surfaces (queued/starting/streaming/terminal), reusing the Phase 1 vocabulary. Platform Admin rollout reuses the Feature Flags surface.

## Technical Specification

See the tech spec for the routing seam, fail-closed guard, and the interactive telemetry/alert wiring.
$design8$,
    $tech8$# Technical Specification — Interactive Rollout, Latency SLO, and Worker Health

> **Owning layer:** `src/server/services/` (chat routing seam + telemetry) + existing Platform Admin routes | **Surface:** Full stack
> **Verification builds:** `npx tsc -p tsconfig.server.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit`

## System Boundary and Owning Layer

Adds a thin interactive routing seam at the chat agent dispatch point (mirroring the Phase 1 `backgroundWorkflowRouter` pattern) that evaluates `isFeatureEnabled('ai-runs-interactive', { userId, project, caller: workflowClass })`, plus interactive metrics through the Phase 1 `workerTierTelemetry` module and the existing agent-health endpoint. Rollout reuses `platformAdmin.ts` flag management and audit.

## Security Enforcement

- **Auth:** Super-Admin-gated flag routes unchanged; no new key. Chat visibility stays project-scoped.
- **Sensitive data:** interactive telemetry uses the same allow-list sanitizer as Phase 1 — only `runId`/`dispatchMessageId`/`project`/`lane`/`terminalReason`; never prompt/snapshot/workspace/`CURSOR_API_KEY` (BR-019).

## Architecture and Approach

### Interactive routing (TBI-013)

At the chat entry point the seam evaluates the flag per project and workflow class (`interview | adr | home-chat | ask-apex | assistant`). Enabled + interactive capacity → dispatch to the warm lane (FEAT-007 admission). Disabled, evaluation error, or an interactive **shed** → the existing in-process path (fail-closed, BR-017). Disabling the flag does not terminate in-flight interactive runs; the lifecycle/reaper drains them. Wrapped in `@feature-flag:ai-runs-interactive` cleanup markers.

### Telemetry, health, alert (TBI-014)

Emit via `workerTierTelemetry`: `interactive.firsttoken` (durationMs → P50/P95), `interactive.turn` (durationMs), `interactive.inflight` vs reserved+burst, `interactive.shed`, `interactive.replica.health`, `interactive.replay`. Agent health adds `interactiveSaturation` and `firstTokenSloStatus`. An alert fires when first-token P95 breaches the SLO or reserved capacity is exhausted (thresholds from FEAT-007 config).

## Data and Contracts

| Method | Route | Shape | Auth |
|--------|-------|-------|------|
| GET | `/api/feature-flags/evaluate?project=…` | existing, workflow via `caller` | authenticated user |
| PATCH/POST | `/api/platform-admin/feature-flags/*` | existing flag mgmt + audit | Super Admin |
| GET | existing agent-health (extended) | `+ { interactiveSaturation, firstTokenSloStatus }` | ops/admin |

**Schema:** none — flag rows/rules/audit exist; interactive latency comes from lifecycle timestamps + emitted measurements. Workflow targeting reuses the `caller` dimension (no new `FlagRuleType`).

## Testing Strategy

- **Unit:** fail-closed guard (throw/disabled/shed → in-process, no dispatch); telemetry sanitizer drops secrets; status mapping unaffected.
- **Integration:** per-project/per-workflow interactive targeting; drain-on-disable; agent-health interactive fields; SLO alert on synthetic P95 breach.
- **E2E:** enabled project — chat routes to warm lane and reports first-token within SLO; disable → in-process, dispatched runs drain.

## Verification Test Matrix

| ID | Layer | Assert | Linked |
|----|-------|--------|--------|
| VT-01 | Integration | Enabled project routes to warm lane; first-token within SLO | PBI-009 (a) |
| VT-02 | Unit | Eval failure/disable/shed → in-process, no dispatch | PBI-009 (b) |
| VT-03 | Integration | Disable drains dispatched interactive runs; new turns in-process | PBI-009 (c) |
| VT-04 | Integration | SLO breach / reserved exhaustion → alert + agent-health saturation | PBI-009 (d) |
| VT-05 | Unit | Telemetry sanitizer drops prompt/workspace/secret | BR-019 |

## Rollback and Deployment

Additive; `ai-runs-interactive` default off. Rollback disables the flag (interactive in-process, dispatched runs drain) and removes the routing branch/telemetry with no data cleanup.

## Implementation Plan

- [ ] S1 — Interactive routing seam + fail-closed guard + cleanup markers.
- [ ] S2 — Interactive telemetry + agent-health extension.
- [ ] S3 — SLO/reserved-capacity alert wiring.
- [ ] S4 — Integration + E2E rollout verification.
$tech8$,
    $assume8$# Assumptions & Unresolved Items — Interactive Rollout, Latency SLO, and Worker Health

## Unresolved Items

- ⚠ **First-token latency SLO value:** the target (e.g. first token ≤ ~1.5 s P95 under background load) is not fixed and gates the alert threshold. Confirm with product before enforce.
- ⚠ **Interactive workflow-class taxonomy for flag targeting:** the exact `caller` values (`interview | adr | home-chat | ask-apex | assistant`) reused for per-workflow targeting. Default: extend the Phase 1 `caller`-based scheme.
- ⚠ **Agent-health endpoint route:** inherits the Phase 1 open item on the concrete ops agent-health route to extend.

## Assumptions Accepted

- **Fail-closed is the safe default:** any disabled/error/shed result routes interactive turns in-process (BR-017); a flag or capacity problem never blocks chat.
- **Reuse Phase 1 flag, telemetry, and admin surfaces:** no new page, permission, or telemetry subsystem; the `caller` dimension carries the workflow class.
- **Latency is SLO-bounded, not guaranteed:** the SLO is measured against the shared Cursor upstream quota, which the interactive lane isolates but does not raise.
- **Drain-on-disable reuses lifecycle/reaper:** disabling never force-cancels in-flight interactive runs.
$assume8$,
    'approved', v_reviewer, v_now, 96, v_skill, v_now, v_now
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

  -- ── Append the Phase 2 interactive decision to the companion worker-tier ADR ────────────────
  UPDATE adrs
  SET content = content || $adr$


<!-- PHASE2-INTERACTIVE-APPENDED -->

## Phase 2 Addendum — Interactive Warm Worker Lane (specified)

The interactive lane deferred above is now specified as a concrete decision, delivered under the
PRD "Move AI agent execution to a bounded worker tier" as the fourth Epic
**Real-Time Interactive Agent Worker Tier (Phase 2)** (Features FEAT-007..009, TBI-009..014,
PBI-007..009, business rules BR-013..019).

**Decision.** Interactive agents (Interview, ADR, Agent Home chat, Ask Apex, and the calendar/PRD/
design assistants) execute on a **warm, long-lived Container App** on a new `ai-runs-interactive`
Service Bus lane rather than as ephemeral Jobs, so first token is not gated by cold start. The
Phase 1 admission governor becomes **dual-lane**: the background lane keeps its bounded cap (8–12)
while the interactive lane holds **reserved warm capacity** that background admission can never
consume, and interactive demand over capacity **sheds immediately to the in-process path** instead
of queuing. Interactive turns are dispatched per chat thread in order (one in-flight run per thread
via `chat_threads.active_run_id`), run the shared Cursor execution core on a **sticky** warm replica
that reuses a grounded checkout across turns via `Agent.resume`, and stream **batched** token/tool/
progress events back over the existing Postgres `LISTEN/NOTIFY` → SSE spine (coalesced to respect the
~8 KB payload limit). Wedged tool calls are still terminated by the **event-driven bounded per-tool
deadline** (that ADR remains a prerequisite; moving compute off-box does not make a stuck `tool_call`
return). Rollout is gated by a default-off `ai-runs-interactive` Feature Flag with **fail-closed**
in-process fallback and **drain-on-disable**, and by a **first-token latency SLO** with alerting.

**Why this closes the goal.** With Phase 1 (background) and Phase 2 (interactive) together, tens of
background design-doc generations can run while many users interact with any Apex chat agent in near
real time — the always-on, Base44-style agent experience — because the two workloads are isolated,
independently bounded, fairly co-scheduled, and streamed durably rather than competing on the web
tier for the event loop.

**Reused invariants.** DB-authoritative `agent_runs` lifecycle and lane; fenced runner ingest
(`AiRun.Runner` + `dispatchMessageId`); durable fan-out and `replayRunEvents`; lane-aware reaper;
worker-tier telemetry and Feature Flag rollout — all reused, with interactive-specific reserved
capacity, sticky sessions, token batching, reaper clocks, and latency SLO added on top.
$adr$,
      updated_at = v_now
  WHERE id = '436850c6-6a98-4cb4-b31e-886ef18c7aec'
    AND content NOT LIKE '%PHASE2-INTERACTIVE-APPENDED%';

END
$phase2_interactive$;

-- Down Migration

DELETE FROM design_docs
WHERE id IN (
  'a1c2e3f4-0b1d-4e2f-8a3b-6c7d8e9f0016',
  'a1c2e3f4-0b1d-4e2f-8a3b-6c7d8e9f0017',
  'a1c2e3f4-0b1d-4e2f-8a3b-6c7d8e9f0018'
);

UPDATE adrs
SET content = regexp_replace(content, E'\\n\\n<!-- PHASE2-INTERACTIVE-APPENDED -->[\\s\\S]*$', ''),
    updated_at = now()
WHERE id = '436850c6-6a98-4cb4-b31e-886ef18c7aec';

UPDATE prds
SET backlog_json = jsonb_set(
      jsonb_set(
        jsonb_set(
          backlog_json,
          '{epics}',
          (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
             FROM jsonb_array_elements(backlog_json->'epics') e
            WHERE e->>'title' <> 'Real-Time Interactive Agent Worker Tier (Phase 2)')),
        '{businessRules}',
        (SELECT COALESCE(jsonb_agg(b), '[]'::jsonb)
           FROM jsonb_array_elements(backlog_json->'businessRules') b
          WHERE (b->>'id') NOT IN ('BR-013','BR-014','BR-015','BR-016','BR-017','BR-018','BR-019'))),
      '{implementationPhases}',
      (SELECT COALESCE(jsonb_agg(p), '[]'::jsonb)
         FROM jsonb_array_elements(backlog_json->'implementationPhases') p
        WHERE NOT (p->'epics' ? 'Real-Time Interactive Agent Worker Tier (Phase 2)'))),
    content = regexp_replace(content, E'\\n\\n\\n---\\n\\n## Phase 2 — Real-Time Interactive Agent Worker Tier[\\s\\S]*$', ''),
    updated_at = now()
WHERE id = '45f17f84-bdb9-437e-bb6e-9c10ff5a2b37';
