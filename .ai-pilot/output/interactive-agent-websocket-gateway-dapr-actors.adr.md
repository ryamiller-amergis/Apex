---
adr-number: ADR-pending
status: Proposed
date: 2026-08-06
slug: interactive-agent-websocket-gateway-dapr-actors
---

# Real-Time Interactive Agent Transport: WebSocket Gateway with Dapr Virtual Actors on Azure Container Apps

## Status

Proposed

Supersedes the deferred Phase 2 interactive-worker approach (the removed FEAT-007/008/009 specs and the "warm interactive Container App on an `ai-runs-interactive` Service Bus lane" note appended to the companion worker-tier ADR). Those specs routed each live conversation turn through a Service Bus queue; this ADR replaces that transport for interactive work only. Background execution (Phase 1) is unchanged.

## Context

Phase 1 moved **background** generation (PRD, design doc, validation, test cases) off the web tier onto a bounded worker tier: a DB-authoritative `agent_runs` queue, a fair Admission Governor (`src/server/services/admissionGovernorService.ts`), a payload-free managed-identity publisher (`src/server/services/serviceBusPublisher.ts`), and a KEDA-scaled ephemeral Container Apps Job on the shared `sbns-apex-ai-*` namespace with the `ai-runs-background` queue (`infra/ai-runs-worker.tf`). That machinery already exists and works well for latency-tolerant, fire-and-forget jobs.

**Interactive** agents — Design Interviews, ADR interviews, Agent Home chat, Ask Apex, and the PRD/design-doc assistants — still run **in-process** on the web tier. Each turn flows:

- `POST /api/chat/threads/:id/messages` returns `202` and fires `sendMessage()` (`src/server/routes/chat.ts`, `src/server/services/chatAgentService.ts`).
- `sendMessage()` creates or resumes the Cursor SDK session (`Agent.create` / `Agent.resume`) on the web process and streams tokens.
- Tokens/tools/progress fan out over PostgreSQL `LISTEN/NOTIFY` and are relayed to the browser via SSE (`src/server/services/pgNotifyService.ts`, the SSE route in `src/server/routes/chat.ts`, consumed by `src/client/hooks/useChatStream.ts`).

This means a burst of heavy background generation still competes with live conversations for the web event loop and the shared Cursor upstream quota, degrading interview responsiveness. The problem the removed Phase 2 specs tried to solve is real: **isolate interactive conversations from background load with warm, reserved capacity.** The mechanism they chose — a second Service Bus queue plus a warm Container App, with "sticky thread→replica affinity" and "resume-on-loss" bolted on top — is a poor fit for a latency-sensitive, back-and-forth conversation:

- A broker enqueue/poll hop sits on the critical path of every user-visible turn.
- A pull-based queue hands a turn to whatever replica polls next, so per-thread session stickiness and ordering must be re-implemented against the broker's grain.
- KEDA scale-on-queue-depth reacts *after* backlog forms — the opposite of the warm, first-token-fast behavior interactive work needs.

The durable half of the current design is sound and worth preserving: DB-authoritative run lifecycle, the immutable `agent_run_events` log, ordinal reconnect replay (`replayRunEvents`), and cross-instance fan-out. Only the interactive **transport** and **session placement** need to change. The target experience is a Base44/GoDaddy-Airo-style always-on conversational agent: a persistent duplex connection to the browser and a live per-conversation session that holds warm context between turns.

Constraint from platform conventions (`.cursor/rules/azure-async-infra.mdc`, `.cursor/skills/azure-async-infra/SKILL.md`): do not provision new brokers or overload a job queue for pub/sub fan-out; prefer topics/pub-sub for fan-out and reserve Service Bus queues for competing-consumer jobs.

## Decision Drivers

- **First-token latency under load** — a live turn must start streaming quickly even while ~40 background runs execute; no broker hop or cold-start on the interactive path.
- **Isolation with reserved capacity** — interactive must hold warm capacity that background admission can never consume; saturation must fail fast, not queue unbounded.
- **Per-thread ordering and session continuity** — one in-flight turn per thread, with a warm `Agent.resume` session and grounded checkout reused across turns.
- **Reconnect safety** — a client that drops and reconnects (possibly to another instance) must replay missed events by ordinal without duplication.
- **Reuse over reinvention** — preserve `agent_runs`, `agent_run_events`, the execution core, and the existing background Service Bus lane; avoid a parallel spine.
- **Operational and infra fit** — stay within the shared Azure platform pattern (managed identity, entity-scoped RBAC, Terraform in `infra/`) and minimize net-new operational surface.
- **Bounded blast radius** — default-off rollout with fail-closed fallback to the current in-process path.

## Considered Options

### Option 1 — Interactive Service Bus lane + warm Container App + dual-lane admission (the removed FEAT-007/008/009 approach)

Add an `ai-runs-interactive` queue on the shared namespace, a warm Container App scaled by KEDA on interactive queue depth, dual-lane reserved/burst admission, and reconstruct thread→replica stickiness plus resume-on-loss above the queue.

- **Benefits:** maximal reuse of Phase 1 publisher/KEDA shapes; one consistent dispatch story for background and interactive.
- **Costs / risks:** a broker enqueue/poll hop on every conversational turn; pull-based delivery fights per-thread affinity and ordering; KEDA scale-on-depth reacts after backlog forms (cold-start on first token); "sticky affinity" and "resume-on-loss" become compensators for the broker's own semantics. Violates the "don't use a job queue for interactive fan-out / real-time" grain in `azure-async-infra`.

### Option 2 — WebSocket agent gateway + Dapr virtual actors on Azure Container Apps (chosen)

A stateless WebSocket gateway terminates the browser socket and authenticates; behind it, a warm Dapr **virtual actor** per `threadId` (single activation cluster-wide, turn-based concurrency) holds the `Agent.resume` session and warm grounded checkout and runs the shared execution core. Live tokens push to the socket-holding gateway over a Dapr pub/sub backplane; every event is still persisted to `agent_run_events` for ordinal reconnect replay. Runs on Azure Container Apps (managed Dapr) with warm `min_replicas > 0` for the actor app and burst scaling on concurrency/CPU. No Service Bus on the interactive path.

- **Benefits:** no broker hop on a turn (in-cluster actor invoke); **affinity and ordering are intrinsic** — "one actor per thread, single activation, turn-based" *is* the sticky-thread and single-in-flight requirement, so the runtime does placement/serialization instead of hand-rolled logic; synchronous "actor busy" gives immediate fail-closed backpressure; reuses `agent_run_events` + `replayRunEvents` for durability and reconnect; managed Dapr on ACA supplies actor placement, turn-based concurrency, and pub/sub without a bespoke placement service; matches the Base44/Airo duplex feel.
- **Costs / risks:** net-new operational surface (Dapr control plane, actor lifecycle, a low-latency pub/sub backplane such as Azure Cache for Redis / Redis Streams); a **client transport rewrite** from `EventSource` to a WebSocket client in `useChatStream.ts`; ACA WebSocket ingress and session behavior must be validated; single-activation introduces actor-failover and placement-rebalance edge cases to test.

### Option 3 — Direct HTTP/2 (or gRPC) dispatch to a warm worker pool + Postgres worker registry

Keep SSE to the client. Replace the interactive queue with a synchronous, in-cluster HTTP/2 dispatch from the web tier to a warm worker chosen from a Postgres-backed registry, using consistent hashing of `threadId` for affinity and resume-on-loss.

- **Benefits:** removes the broker hop; smallest change (reuses existing SSE + NOTIFY spine, no client rewrite); no Dapr/Redis to operate.
- **Costs / risks:** you re-implement placement, single-activation, turn-based ordering, heartbeats, and failover yourself in the registry/router — the exact bespoke machinery Dapr actors provide for free; SSE-only keeps the request/response + separate-stream split rather than a true duplex conversational channel, so it is further from the Base44/Airo experience the product is targeting.

### Option 4 — Status quo: keep interactive in-process on the web tier

Do nothing; rely on the web tier for interactive turns.

- **Benefits:** zero delivery cost.
- **Costs / risks:** does not solve the isolation problem — background bursts continue to degrade live interviews and share the Cursor quota with no reserved interactive capacity.

## Decision Outcome

Chosen option: **Option 2 — WebSocket agent gateway + Dapr virtual actors on Azure Container Apps.**

It is the only option that satisfies the latency, affinity/ordering, and isolation drivers *without* re-implementing distributed session placement by hand, while reusing the durable spine already in the codebase. The virtual-actor model maps the requirements one-to-one: single activation per `threadId` gives sticky session placement; turn-based actor concurrency gives one-in-flight-per-thread ordering; a synchronous "actor busy" result gives immediate fail-closed backpressure; and actor reminders can drive stuck-turn termination in place of a bespoke interactive reaper clock. Managed Dapr on ACA provides these primitives plus pub/sub, keeping net-new code focused on the gateway, the actor host, and the client transport rather than on a placement/registry service (Option 3).

**Scope of the transport decision, and Service Bus:**

- **Background (Phase 1) is unchanged and explicitly retained.** The shared `sbns-apex-ai-*` namespace, the `ai-runs-background` queue, the managed-identity publisher, the Admission Governor, and the KEDA-scaled ephemeral Job continue to serve latency-tolerant generation. **No new Service Bus resource is introduced** by this ADR, and the previously proposed `ai-runs-interactive` queue is explicitly **not** created. This honors the `azure-async-infra` rule against using a job queue for real-time/fan-out and against provisioning brokers without a driver.
- **Interactive** turns are dispatched **in-cluster** (gateway → actor), never through Service Bus.
- **Durability is shared, not duplicated.** Interactive runs keep writing to `agent_runs` and `agent_run_events`; `replayRunEvents` remains the reconnect-replay mechanism. The Dapr pub/sub backplane carries only the *live* low-latency fan-out from actor to the socket-holding gateway; it is not a durable store.

**Reserved-capacity isolation** stays a property of admission: the reserved/burst accounting concept from the removed FEAT-007 remains valid, but it now gates **actor activation** (and warm `min_replicas`) rather than a Service Bus publish. Background admission can never consume interactive reserved slots.

**Platform target:** Azure Container Apps with managed Dapr, chosen for native WebSocket ingress, warm `min_replicas > 0` (never scale-to-zero) with concurrency/CPU burst, internal ingress + Dapr service invocation (mTLS) for gateway→actor, and consistency with the existing `cae-apex-ai-*` Container Apps Environment and identity/Key Vault/ACR wiring in `infra/ai-runs-worker.tf`. The low-latency backplane is expected to be Azure Cache for Redis (Dapr pub/sub + actor state store); its exact SKU is deferred to the implementing design/Terraform.

**Rollout:** gated by a default-off Feature Flag with fail-closed fallback to the existing in-process `sendMessage()` path and drain-on-disable, mirroring the Phase 1 `ai-runs-background` rollout discipline.

## Consequences

### Positive

- Removes the broker hop and cold-start from the interactive critical path; first-token latency under background load improves.
- Sticky per-thread session placement and one-in-flight-per-thread ordering are provided by the actor runtime instead of hand-written affinity/ordering code.
- Reserved warm capacity isolates conversations from background bursts; saturation fails fast to in-process rather than queuing unboundedly.
- Reuses `agent_runs`, `agent_run_events`, `replayRunEvents`, the shared execution core, and `Agent.resume`, avoiding a parallel spine.
- Leaves the proven Phase 1 Service Bus background lane untouched and adds no new broker, staying within `azure-async-infra` conventions.
- Delivers a true duplex, always-on conversational channel aligned with the Base44/Airo target experience.

### Negative

- New operational surface: Dapr control plane, virtual-actor lifecycle/placement, and a low-latency pub/sub backplane (expected Azure Cache for Redis) to provision, secure, and monitor.
- A client transport rewrite is required: `src/client/hooks/useChatStream.ts` migrates from `EventSource`/SSE to a WebSocket client (retaining the ordinal/`seenEventIds` dedup and replay logic). This is net-new work not present in the removed specs.
- Single-activation actors introduce failover and placement-rebalance edge cases (actor loss mid-turn, resume from persisted `cursor_agent_id` + events) that must be explicitly tested.
- ACA WebSocket ingress behavior, connection limits, and idle timeouts must be validated; a live backplane adds a runtime dependency whose outage degrades real-time push (durability/replay still hold via Postgres).
- Two transports coexist during rollout (in-process fallback vs. actor path behind the flag), adding temporary routing/telemetry complexity until the flag is retired.

### Unresolved / follow-up

- Backplane choice and SKU (Azure Cache for Redis tier vs. alternative Dapr pub/sub component) and its Terraform ownership.
- First-token latency SLO value and the alert threshold for reserved-capacity exhaustion.
- Reserved vs. burst sizing for the warm actor pool (`min_replicas` and burst ceiling).
- ACA WebSocket session/affinity settings and connection-scaling limits at target concurrency.
- Whether stuck-turn termination uses Dapr actor reminders or extends the existing reaper.

## References

- Removed/superseded specs: `.ai-pilot/local-dev/feat-007`, `feat-008`, `feat-009` (interactive Service Bus lane, session relay, rollout) — replaced by this ADR.
- Phase 1 background lane (retained): `infra/ai-runs-worker.tf`, `infra/ai-runs-worker-entra.tf`, `src/server/services/serviceBusPublisher.ts`, `src/server/services/admissionGovernorService.ts`, `src/server/services/backgroundWorkflowRouter.ts`.
- Durable spine reused: `src/server/services/pgNotifyService.ts` (`notifyRunEvent`, `replayRunEvents`), `src/server/services/agentRunLifecycleService.ts`, `src/server/db/schema.ts` (`agent_runs`, `agent_run_events`).
- Interactive execution today: `src/server/services/chatAgentService.ts` (`sendMessage`, `Agent.create`/`Agent.resume`), `src/server/routes/chat.ts` (message + SSE routes), `src/client/hooks/useChatStream.ts` (SSE consumer to be migrated to WebSocket).
- Platform conventions: `.cursor/skills/azure-async-infra/SKILL.md`, `infra/shared-async.tf`, `.cursor/rules/azure-async-infra.mdc`; `.cursor/skills/terraform-infra/SKILL.md`, `.cursor/rules/terraform-infra.mdc`, `infra/README.md` (expected new `*.tf` for the actor host + gateway + backplane).
- External patterns referenced for the target experience: Dapr virtual actors (single activation, turn-based concurrency) on Azure Container Apps managed Dapr; Base44 / GoDaddy Airo conversational agent transports.
