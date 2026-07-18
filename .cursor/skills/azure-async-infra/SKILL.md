---
name: azure-async-infra
description: >-
  Apex conventions for shared Azure Blob Storage and optional Service Bus
  (queues for jobs, topics for pub/sub, containers for blob isolation). Use when
  designing or interviewing about async jobs, messaging, pub/sub, workers, Blob
  storage, Service Bus, Terraform infra in infra/, ADRs involving cloud messaging
  or artifact storage, /grill-design or /adr-interview topics that touch queues,
  topics, workers, or file/blob artifacts.
---

# Azure Async Infrastructure

Canonical platform pattern for Apex async work. Inspect `infra/shared-async.tf`,
`infra/pdf-processing.tf`, and `infra/README.md` before inventing alternatives.

## Default decision (current)

| Concern | Default | Exception |
|---------|---------|-----------|
| Storage | **One** private Storage Account per environment | Separate account only for hard security, lifecycle, compliance, or cost isolation |
| Blob isolation | **Container per workload** (`pdf-artifacts`, …) keyed `{userId}/{sessionId}/...` where applicable | — |
| PDF / current-scale job delivery | **Postgres job queue** (existing claim/lease patterns) | Managed broker only when ADR scale-up triggers fire |
| Messaging (future) | **One** Service Bus namespace per environment when a broker is justified | Separate namespace only for hard isolation / SKU / blast-radius needs |
| Competing-consumer jobs (when broker exists) | **Queue** per workload | Never one mega-queue for unrelated domains |
| Pub/sub / fan-out | **Topic + subscriptions** | Do not overload a job queue for fan-out |
| Worker compute | Prefer the Apex App Service until isolation/scale requires a dedicated host | New App Service solely to “own” Blob |
| Auth | Managed identity; entity-scoped RBAC | No shared keys in app settings as the primary path |

PDF is the **first consumer** of shared Blob (`pdf-artifacts`) and runs **inside Apex**.
Service Bus is **not** provisioned by default (revised PDF scale ADR).

## Interview / ADR checklist

When an ADR, grill-design, or infra interview touches async work, force these
choices early (one question at a time if interviewing):

1. **Job vs event** — Is each message processed once by a worker (queue) or
   fan-out to independent consumers (topic)? Or is Postgres enough at this scale?
2. **Shared vs isolated** — Can this reuse `infra/shared-async.tf` containers?
   What concrete boundary would justify a new account/namespace?
3. **Container name** — Propose a stable kebab-case container name and path layout.
4. **RBAC principals** — Which API identities need Blob Data Contributor, and at
   which container scope?
5. **Broker needed?** — Prefer Postgres until ADR scale-up triggers (CPU
   saturation despite autoscale, governor rejecting frequently, etc.).
6. **Worker host** — Default: process inside the Apex App Service. Only propose a
   dedicated plan/app when isolation or scale evidence requires it.
7. **Local/dev** — Point at shared non-prod Azure Blob unless an ADR explicitly
   adopts emulators.

Record rejected options (dedicated namespace for every module, shared mega-queue,
new App Service just to hold Blob settings, Service Bus for PDF at ~20 concurrent
users without evidence) with the driver that killed them.

## Extending the platform (implementation shape)

1. Add a key to `blob_containers` in Terraform variables.
2. Add container-scoped `azurerm_role_assignment`s for the consuming identities.
3. Wire module-specific app settings to shared outputs
   (`shared_storage_account_name`, container name) — do not invent
   connection-string-first contracts.
4. Update `infra/README.md` smoke notes if operators need a new check.
5. Only add Service Bus when an accepted ADR scale-up path requires it — then
   prefer one shared namespace with queues/topics maps.

## Anti-patterns

- New Storage Account or Service Bus namespace “because this feature is special”
  without an isolation driver
- Provisioning Service Bus for PDF (or similar) when the revised capacity model
  uses Postgres + Blob + App Service autoscale
- One queue for all Apex async work
- Public blob containers or anonymous access
- Packing heavy conversion onto the API plan **without** acknowledging scale risk
  (prefer concurrency governor + autoscale; split compute only with evidence)
- Provisioning a separate PDF/worker App Service when the only need is Blob for
  features that already run in Apex

## Related skills

- `/terraform-infra` — how Apex Terraform is structured, validated, and documented
- `/adr-interview` — load this skill when the decision involves messaging,
  workers, or blob/artifact storage
- `/grill-design` — apply these defaults when technical discovery covers async
  or infra
- `/adr-finalize` — cite `infra/shared-async.tf` and this skill in References
  when the ADR selects the shared Blob platform
