---
name: azure-async-infra
description: Conventions for shared Azure async infrastructure (Blob Storage, Service Bus, queues, topics, workers). Use when designing or interviewing about async jobs, messaging, pub/sub, workers, Blob storage, Service Bus, or Terraform infra involving cloud messaging or artifact storage.
---

# Azure Async Infrastructure — Foundation

Canonical patterns for Azure async work. Always inspect existing infrastructure files before inventing alternatives.

## Default decisions

| Concern | Default | Exception |
|---------|---------|-----------|
| Storage | One private Storage Account per environment | Separate account only for hard security, lifecycle, compliance, or cost isolation |
| Blob isolation | Container per workload, keyed `{userId}/{sessionId}/...` where applicable | — |
| Small-scale job delivery | Postgres job queue (existing claim/lease patterns) | Managed broker only when evidence-based scale-up triggers fire |
| Messaging | One Service Bus namespace per environment when a broker is justified | Separate namespace only for hard isolation or blast-radius needs |
| Competing-consumer jobs | Queue per workload | Never one mega-queue for unrelated domains |
| Pub/sub / fan-out | Topic + subscriptions | Do not overload a job queue for fan-out |
| Worker compute | Prefer the existing app service until isolation/scale requires a dedicated host | — |
| Auth | Managed identity; entity-scoped RBAC | No shared keys as the primary path |

## Interview / ADR checklist

When an ADR or technical interview touches async work, surface these choices early (one question at a time if interviewing):

1. **Job vs event** — Is each message processed once by a worker (queue) or fan-out to independent consumers (topic)? Or is Postgres enough at this scale?
2. **Shared vs isolated** — Can this reuse the project's shared async infrastructure? What concrete boundary would justify a new account/namespace?
3. **Container/queue name** — Propose a stable kebab-case container name and path layout.
4. **RBAC principals** — Which API identities need Blob Data Contributor, and at which container scope?
5. **Broker needed?** — Prefer Postgres until scale-up triggers are observed.
6. **Worker host** — Default: process inside the existing app service. Only propose a dedicated plan when isolation or scale evidence requires it.

Record rejected options with the driver that killed them.

## Extending the platform

The project adapter describes project-specific infrastructure files to inspect. See the adapter for:
- The shared infrastructure Terraform file in the project's `infra/` directory
- Container/queue naming conventions
- App settings contracts

## Anti-patterns

- New Storage Account or Service Bus namespace without an isolation driver
- Provisioning Service Bus when Postgres + app service autoscale is sufficient
- One queue for all async work domains
- Public blob containers or anonymous access
- New dedicated worker App Service solely to "own" Blob settings
