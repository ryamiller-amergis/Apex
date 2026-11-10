---
adr-number: ADR-pending
status: Accepted
date: 2026-11-05
slug: build-preview-provider-boundary
approved-by: Phase 2 product owner
approval-source: Cursor session approval on 2026-11-05
---

# Build Preview Provider Boundary

## Status

Accepted for the Phase 2 pilot.

## Context

Phase 1 couples preview settlement to an Azure DevOps pipeline callback that supplies a static preview URL. Phase 2 needs separate artifact production, isolated compute, synthetic data, gateway publication, browser verification, and cleanup.

No current Azure option has a proven production contract for arbitrary generated browser applications:

- Custom Dynamic Sessions document custom application endpoints for GET and POST only, require Apex to retain the Entra management token, and do not document cookies, SSE, WebSockets, arbitrary payload limits, or custom-domain browser ingress.
- Azure Container Apps Sandboxes are generally available and provide hardware-isolated microVMs, custom images, process and port operations, and granular egress, but have no availability SLA.
- Regular Container Apps are mature but are not the default trust boundary for arbitrary generated code.

Provider details must not enter Apex build domain types or the generated application contract.

## Decision Drivers

- Keep Azure DevOps as an artifact builder without making it the preview lifecycle authority.
- Run one conformance suite against local and cloud implementations.
- Make retries and reconciliation safe after restarts or duplicate callbacks.
- Allow an Azure pilot without claiming that general availability alone satisfies the product's reliability and browser-ingress requirements.
- Keep the browser gateway independent from provider endpoints and credentials.

## Considered Options

### Extend the current callback with more provider-specific fields

This is the smallest change, but it keeps artifact build, compute, data, routing, and product state coupled to Azure DevOps and one Azure runtime. Rejected.

### Use one broad preview-provider interface

A single interface is simpler initially but mixes independent failure domains and makes replacement difficult. Rejected.

### Use separate provider ports with durable desired state

Artifact build, compute, data, and routing have independent contracts. Apex persists provider handles and reconciles desired state. Chosen.

## Decision Outcome

Chosen option: **separate provider ports with an Apex-owned reconciler**.

Required ports:

- `PreviewArtifactProvider`: start, inspect, and cancel an immutable artifact build.
- `SandboxProvider`: provision, inspect, renew, suspend, resume, and destroy isolated compute.
- `SandboxDataProvider`: create, migrate, seed, and destroy preview data.
- `PreviewGatewayProvider`: create unpublished routes, probe transport health, publish, swap, and revoke them. Transport probing does not replace Apex's browser verifier or satisfy the browser-evidence gate.

Every mutating operation requires an idempotency key. Apex persists desired state, operation IDs, provider handles, artifact and image digests, data handles, route handles, expiry, and cleanup state. Provider callbacks are observations; they do not directly declare a build complete.

Implementations:

- `AdoPreviewArtifactProvider` wraps the current queue/poll pipeline and returns immutable artifacts and attestations.
- `StaticBundlePreviewProvider` preserves Phase 1 as a rollback-only adapter.
- `DockerSandboxProvider` and `DockerPostgresSandboxDataProvider` provide the local walking skeleton and CI conformance target.
- `AzureContainerAppsSandboxesProvider` is the preferred isolated Azure pilot.
- Regular Container Apps may be evaluated only for repositories classified as trusted.
- Custom Dynamic Sessions is rejected as the direct browser runtime unless Microsoft expands and documents the required protocol contract.

Pilot gateway transport:

- Expose the sandbox application port through the provider's Entra-protected endpoint, never anonymous ingress.
- A dedicated Apex preview gateway uses its managed identity to call that endpoint and keeps the endpoint and provider handle server-side.
- Requests without the gateway identity must receive `401` or `403`.
- The browser connects only to the separate preview domain; the gateway proxies HTTP, streaming, and WebSocket traffic.
- If the provider cannot restrict or authenticate the endpoint for this pattern, or the protocol conformance test fails, the Sandboxes pilot is a no-go. Private connectivity remains the preferred production path when the provider supports it.

Production cloud selection remains conditional. The Sandboxes pilot must prove:

- GET, POST, PUT, PATCH, DELETE, and OPTIONS
- cookies and iframe behavior
- SSE or streamed responses
- WebSocket upgrades
- configured request and response sizes
- private PostgreSQL connectivity
- gateway/custom-domain routing
- readiness and browser-proof SLOs
- duplicate provisioning and complete teardown

The pilot may not become the production default while its no-SLA reliability posture or browser protocol contract remains unacceptable.

## Consequences

### Positive

- Provider replacement does not change build state or generated application contracts.
- Local and cloud providers share lifecycle and failure tests.
- ADO remains useful without owning authorization, routing, TTL, or cleanup.
- Partial failures can be reconciled after process restarts.

### Negative

- Four ports and durable reconciliation add more initial work than extending the callback.
- The first Azure implementation is a pilot, not a production commitment.
- Provider conformance tests must cover asynchronous and partial-failure behavior.

## References

- `src/server/services/buildPipelineClient.ts`
- `src/server/services/buildDeploymentService.ts`
- `src/server/services/buildPreviewBundleIngestService.ts`
- `design-docs/build-deployment-callback.md`
- https://learn.microsoft.com/en-us/azure/container-apps/session-pool
- https://learn.microsoft.com/en-us/azure/container-apps/sessions-usage
- https://learn.microsoft.com/en-us/azure/container-apps/sessions-custom-container
- https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview
- https://learn.microsoft.com/en-us/azure/reliability/reliability-container-apps-sandboxes
- https://azure.microsoft.com/en-us/blog/designing-agent-first-platforms-what-changes-when-agents-do-the-work/
