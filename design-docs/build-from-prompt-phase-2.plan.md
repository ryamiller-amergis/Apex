# Build from Prompt — Phase 2 Live App Studio Plan

Status: Proposed  
Scope: Golden Stack evolution, isolated full-stack previews, and App Studio UX  
Primary invariant: A build is not complete until its current revision runs in an isolated live environment and passes browser verification.

## Outcome

Phase 2 turns the Phase 1 Build from Prompt pipeline into a one-stop application-building experience:

1. A user describes an application or feature.
2. Apex plans and implements it against the Full-Stack Express Golden Stack.
3. Apex starts the complete generated application in an isolated sandbox.
4. Migrations and synthetic seed data run inside the preview boundary.
5. Apex verifies the public preview in a real browser.
6. The user sees and tests the live application beside the conversation.
7. Revisions replace the preview only after the replacement passes.
8. Accept produces a reviewable pull request; later releases may add new-repository and ZIP outputs.

The Phase 1 static preview remains available as a rollback path during rollout, but it cannot satisfy the Phase 2 completion invariant.

## Evidence from the Current Implementation

Phase 1 already provides the control-plane and UX foundation:

- `src/client/components/BuildWorkspace.tsx` is already a split-screen chat and preview workspace.
- `src/client/components/BuildSandboxPreview.tsx` already provides iframe, refresh, open-in-new-tab, and responsive viewport controls.
- `src/server/services/buildDeploymentService.ts` owns deployment queueing, settlement, retry, events, and notifications.
- `src/server/services/buildPreviewArtifactService.ts` stores token-gated static preview bundles.
- `src/server/services/buildPreviewBundleIngestService.ts` settles a deployment after a static bundle upload.
- `src/server/services/buildRunProjectionService.ts` and `buildRunDeploymentProjection.ts` expose preview state to the client.
- `templates/full-stack-express` already has Express, React, shared Zod contracts, Drizzle/PostgreSQL migrations, synthetic seed data, health endpoints, a production Dockerfile, quality manifests, and agent grounding.

The current preview is not yet a live full-stack application:

- `templates/full-stack-express/azure-pipelines.yml` builds only `apps/web` with `VITE_APEX_PREVIEW_MODE=sample`.
- `apps/web/src/api/previewSampleStore.ts` uses browser-memory sample state rather than the generated API and database.
- Deployment can become `preview_ready` after receiving a URL; it does not require a browser journey.
- The project/repository preview lease serializes previews even when isolated environments could run concurrently.
- There is no passing Playwright journey covering prompt → build → live full-stack preview. Existing build specs are skipped or still target the older `BuildRunView` and test IDs while the routed experience is `BuildWorkspace`.
- The current static path is validated commit → `grantNext` → Azure DevOps queue → web-only sample build → `POST /api/internal/build-deployments/preview-bundle` → bundle ingest → callback settlement → token URL → lease-gated `isLive` projection. The legacy adapter must wrap this complete path.
- The pipeline uses Node 20 and npm while the Golden Stack declares Node 24 and pnpm 10. The rollback pipeline must either be brought into parity or explicitly treated as a separate legacy contract.
- Preflight currently uses `foundation-skills/starters/react-mui-express`, while generated applications use `templates/full-stack-express`. Phase 2 must establish one versioned Golden Stack contract for preflight, frozen launch snapshots, preview manifests, and generated repositories.

## Architecture Decisions

### Decision 1 — Sandbox infrastructure belongs to Apex

Do not provision a separate sandbox platform stack inside each generated repository or once per Apex project.

Apex owns shared environment-level infrastructure:

- Sandbox session pool
- Provider credentials and managed identity
- Private artifact storage
- Preview gateway, wildcard DNS, and certificates
- Quotas, TTLs, cleanup, reconciliation, monitoring, and cost controls
- Browser verification workers and evidence storage

Allocate one isolated sandbox session per build revision. A project may have several concurrent sessions within its quota.

Generated applications own only the application runtime contract:

- Install/build/start commands
- Runtime and package-manager versions
- Port and health endpoints
- Migrations and synthetic seed command
- Required environment variable names
- Deterministic runtime-bundle command
- Playwright preview journey
- Golden Stack/template version

This separation lets one infrastructure fix protect every generated app without copying Terraform into every repository.

### Decision 2 — Use a provider port

Introduce a provider-neutral `BuildPreviewProvider` boundary. The provider owns compute allocation, not Apex build state.

Required operations:

- `allocate`
- `inspect`
- `renew`
- `terminate`

Apex continues to own:

- Commit and artifact validation
- State transitions
- Public URL publication
- Browser verification
- Evidence recording
- Authorization
- Revision replacement

Adapters:

1. In-memory provider for service tests
2. Local Docker provider for local development and deterministic integration tests
3. Azure Container Apps custom Dynamic Sessions pilot provider
4. Existing static bundle provider during migration
5. Regular Azure Container Apps for trusted workloads or Azure Container Apps Sandboxes as fallback providers
6. Optional E2B/Daytona provider only if Azure options fail the acceptance criteria

Azure Container Apps custom Dynamic Sessions are the preferred pilot because they provide prewarmed custom containers, Hyper-V isolation, configurable lifecycle, and outbound-network controls while matching the existing Azure platform. They remain a pilot candidate until a spike proves the required HTTP methods, streaming, WebSockets, cookies, payload limits, and latency. Documented custom-session endpoints currently guarantee only GET and POST.

Keep compute allocation separate from the other external seams:

- `PreviewArtifactProvider` packages or retrieves the exact validated revision; the existing ADO queue/poll path becomes `AdoPreviewArtifactProvider`.
- `SandboxDataProvider` creates, initializes, and destroys synthetic preview databases.
- `PreviewGatewayProvider` creates unpublished mappings, publishes verified aliases, revokes access, and swaps revisions.
- Every mutating provider operation accepts an idempotency key.

### Decision 3 — The Golden Stack supplies a contract, not the infrastructure

Extend the Golden Stack with a versioned preview manifest, for example `apex.preview.json`. The final name is decided during the contract slice.

The manifest must declare:

- Schema version
- Template version
- Node and package-manager versions
- Install command
- Build command
- Migration command
- Seed command
- Start command
- Application port
- Liveness and readiness paths
- Preview verification test
- Allowed runtime environment names

The sandbox runner rejects unknown manifest properties and missing required commands.

The Golden Stack also supplies a preview identity adapter. It accepts only a short-lived synthetic principal asserted by the gateway, never receives a real user token, and must reject forged identity headers in production startup tests.

### Decision 4 — Vite+ first; Nx only after a measured spike

Vite+ and Nx solve different problems:

- Vite+ orchestrates and caches JavaScript build, test, lint, format, and type-check tasks. It does not replace pnpm workspace linking, the toolchain check, catalog behavior, TypeScript package builds, or the Docker runtime graph.
- Nx adds project/affected graphs, remote cache, distributed CI, generators, and module-boundary governance.

Adopt Vite+ only after parity tests prove that no Golden Stack guardrail is lost.

Do not assume Nx solves template drift across separate repositories. It does not. Template drift requires version metadata, codemods, published shared packages where appropriate, and automated upgrade pull requests.

Add Nx only if at least one measured condition is true:

- `affected` execution materially reduces CI or agent verification time
- Remote cache sharing across agents and CI is required
- The repository contains enough independently deployed apps/libraries to justify a project graph
- Repeated feature generation needs Nx generators or tag-based boundary enforcement

If each generated application receives its own five-package repository, Vite+ may be sufficient. If the chosen target is one multi-application monorepo, Nx becomes much more valuable.

### Decision 5 — Freeze the frontend foundation through Phase 2

The existing template is already a modern Vite application, not Create React App. Keep the following foundation while delivering the full-stack sandbox:

- React 19, TypeScript, and Vite/Vite+
- TanStack Query for server state
- React Router for routing
- React Hook Form and Zod for forms and validation
- MUI Core as the component implementation
- `packages/ui` as the application-facing design-system boundary

Do not introduce Tailwind, shadcn/ui, Base UI, React Aria, or a second styling system during Phase 2. Replacing MUI is not required to prove prompt → build → verified live preview and would expand the critical path.

Improve generated application quality without changing foundations:

- Expand `packages/ui` with curated navigation, page-shell, form, data-display, empty/loading/error, feedback, and responsive-layout patterns.
- Require meaningful icons for navigation and icon-appropriate actions; never use icons as unlabeled decoration.
- Give generated pages intentional hierarchy, spacing, visual rhythm, responsive behavior, and branded variation rather than raw MUI defaults.
- Update the design-system and build-agent guidance with strong positive examples and an anti-generic checklist.
- Preserve accessibility, keyboard behavior, contrast, and test IDs in every visual profile.
- Keep generated feature code dependent on `packages/ui` where possible so a future primitive migration is contained.

This is a quality track, not a live-preview prerequisite. After Phase 2, run a time-boxed decision spike comparing the retained MUI system with a curated shadcn registry on React Aria or Base UI. Migrate only if the alternative proves better accessibility, generated-code consistency, visual range, bundle/runtime behavior, and upgrade cost.

Version freshness is handled independently of the component choice:

- Pin exact dependency versions for reproducible builds.
- Version each Golden Stack release and record that version in generated repositories.
- Run scheduled dependency-update pull requests through the complete template contract suite.
- Publish codemods or automated upgrade pull requests for supported older template versions.
- Never generate from untested `latest` dependency ranges.

### Decision 6 — Use a dedicated preview origin

Do not expose sandbox-provider endpoints or management tokens to the browser.

Use an opaque host on a separate registrable preview domain, such as:

`https://p-<opaque-key>.<apex-preview-domain>/`

The preview gateway:

- Resolves the opaque key to the current verified instance
- Proxies UI, API, streaming, and WebSocket traffic
- Exchanges a short-lived, single-use launch ticket for a host-only preview session cookie
- Never places persistent bearer credentials or provider session IDs in URLs
- Removes provider credentials and forged identity headers before forwarding
- Applies expiry and revocation
- Sets `frame-ancestors` to approved Apex origins
- Keeps preview cookies and storage separate from Apex

The current iframe omits `allow-same-origin`, which is correct for static content served from the Apex origin. A full-stack application may use `allow-same-origin` only on the separate registrable preview domain so it can use normal browser APIs without sharing Apex's site cookies or storage.

## Target Runtime Lifecycle

1. Freeze the validated commit.
2. Package API output, web output, migrations, seed assets, preview manifest, and SBOM reference into a deterministic bundle.
3. Compute and store the bundle SHA-256 in private Blob storage.
4. Allocate an isolated session using the versioned Golden Stack runner image.
5. Give the session one short-lived, object-scoped artifact grant.
6. Deliver the artifact grant and revision-specific database credential through the authenticated control channel; never place them in pool-wide environment variables.
7. Download the bundle and verify its digest, signature, SBOM/provenance, and configured vulnerability policy.
8. Create an ephemeral preview database.
9. Apply migrations.
10. Load synthetic seed data.
11. Start the production Express runtime, which also serves the compiled web client.
12. Pass liveness and readiness probes.
13. Create an unpublished preview-gateway mapping.
14. Run the required Playwright journey against that exact public URL.
15. Record screenshot, console errors, failed network requests, test output, commit, artifact digest, and session identity.
16. Atomically publish the preview alias.
17. Transition to `preview_ready`.

For a revision, the last verified preview remains visible until the replacement completes step 16. A failed replacement never takes down the last known good preview. After a successful swap, terminate the superseded instance and drop its database after a short bounded grace period. Apply the same cleanup contract to acceptance, cancellation, expiry, and failed provisioning.

## Preview Data Strategy

Use synthetic data only.

The Phase 2 proof must exercise the same PostgreSQL and Drizzle paths as production. The provider spike compares:

1. PostgreSQL inside the isolated session
2. An ephemeral database created on a shared preview-only PostgreSQL server

Choose the option that meets startup, isolation, and cleanup targets. Never connect preview code to production databases.

The sandbox receives no production managed identity and no production secrets. Outbound network access is denied by default. Any allowed host must be explicitly listed by the project preview policy.

## Additive Data Model

Add child tables rather than widening `build_revisions`:

- `build_preview_artifacts`
  - Revision, commit, template version, Blob reference, digest, size, and creation time
- `build_preview_instances`
  - Artifact, provider, external session reference, state, opaque gateway key hash, timestamps, TTL, failure code, and last reconciliation time
- `build_preview_browser_checks`
  - Instance, commit, artifact digest, status, journey version, evidence references, console/network summary, and timestamps

Suggested instance states:

`requested → provisioning → starting → verifying → ready → terminating → terminated`

Terminal alternatives:

`failed`, `expired`

Historical static previews remain readable and are projected as `legacy_static`.

During migration, `build_preview_leases`, revision deployment columns, the internal bundle callback, and token asset routes remain the authority only for `legacy_static`. The new instance and browser-check rows become the authority for live previews. Replace lease-gated `isLive` and URL publication with the gateway alias projection before retiring the shared lease.

The existing FEAT-011 verification matrix remains the implementation-quality record. `build_preview_browser_checks` is additional runtime evidence and is the sole browser-evidence source for `preview_ready` and `accept`; neither record substitutes for the other.

## Non-Bypassable Completion Invariant

A build may enter `preview_ready` only when all of the following refer to the same revision:

- Validated commit
- Preview artifact digest
- Active preview instance
- Passing readiness probe
- Passing browser-check row

`accept` must repeat this check for the current revision.

No E2E deferral, missing browser runner, static HTML bundle, or provider callback alone can satisfy this gate.

Infrastructure failures produce `deployment_failed`. Application or browser failures include a safe plain-language summary and developer diagnostics.

Remove or flag off the current branch-push merge fallback and `autoOpenPullRequestForPoc` path before this gate becomes authoritative. PR creation must use one path and require the same current-revision preview and browser evidence as `accept`.

## TDD Delivery Contract

Every implementation slice follows the same order:

1. Add the failing unit, contract, integration, or browser test.
2. Capture red evidence.
3. Implement the smallest behavior that makes the test pass.
4. Capture green evidence.
5. Run affected quality gates.
6. Demonstrate the behavior through the live preview where the slice is user-visible.

Required test pyramid:

- Pure unit tests
  - State transitions, manifests, digest checks, URL rules, and security headers
- Service tests
  - Idempotency, retries, reconciliation, atomic preview replacement, and cleanup
- Database integration tests
  - Constraints, concurrency, stale callbacks, and TTL cleanup
- Provider conformance suite
  - The same lifecycle tests run against fake, local Docker, and Azure adapters
- Gateway integration tests
  - UI/API path forwarding, query strings, headers, streaming, WebSockets, expiry, and revocation
- Golden Stack contract tests
  - Install, build, migration, seed, liveness, readiness, and runtime bundle
- Client tests
  - A shared live-preview resolver consumes the same projection fixtures as server tests
  - No iframe or accept/PR action is enabled when the current revision contract is false
  - `BuildWorkspace` and `BuildSandboxPreview` render the browser-verified revision only
- Playwright
  - Real preview load, API-backed read, mutation, reload persistence, accessibility, console errors, failed requests, and screenshot
- Azure smoke test
  - At least one real isolated session on deployment of the sandbox platform

## Delivery Sequence

### Milestone 0 — Baseline and decisions

Goal: Freeze measurable baselines and resolve hosting constraints.

Work:

- Record current static-preview success rate and timing
- Record Golden Stack cold/warm install, build, check, and test times
- Confirm preview concurrency, startup SLO, TTL, regional, and sharing requirements
- Confirm whether requester-only synthetic identity is enough for Phase 2
- Prove or reject Dynamic Sessions support for required methods, streaming, WebSockets, cookies, payload size, and startup latency
- Write ADRs for sandbox ownership, provider boundary, preview origin, and database strategy

Exit:

- Decisions are approved
- Baseline metrics are reproducible
- No implementation assumption remains hidden

### Milestone 1 — Completion invariant and local walking skeleton

Goal: Prove a real full-stack preview locally before cloud infrastructure work.

Red:

- `preview_ready` is currently possible without browser evidence
- A local preview does not run API, migrations, seed, and browser verification together

Green:

- Additive preview tables and guarded transition
- Versioned Golden Stack preview manifest
- Golden Stack preview identity adapter with forged-header tests
- Deterministic runtime bundle
- Local Docker provider
- Local preview database
- Browser verifier
- Playwright proves seeded API read, write, and reload
- Remove or flag off branch-push merge and automatic POC PR bypasses

Exit:

- One real build revision reaches a live full-stack preview locally
- The same run cannot reach `preview_ready` when browser verification is removed or fails

### Milestone 2 — Preview gateway and Azure provider

Goal: Run the same contract in an enterprise-isolated cloud session.

Red:

- Provider conformance tests for allocation, inspect, renew, terminate, timeout, and reconciliation
- Gateway tests for authorization, expiry, path forwarding, API traffic, and WebSockets

Green:

- Dedicated preview gateway on a separate registrable origin
- Azure Dynamic Sessions pilot adapter, or the selected fallback adapter if the protocol spike fails
- Private artifact grant flow
- Per-session database credential delivery through the authenticated control channel
- Restricted egress and no workload managed identity
- TTL cleanup and reconciliation
- Monitoring for session leaks, startup failures, and verification failures

Exit:

- A real Azure session displays the full-stack app in Apex
- Playwright evidence passes against the public gateway URL
- Session cleanup is observed after cancel and expiry

### Milestone 3 — Vite+ Golden Stack migration

Goal: Reduce agent feedback time without weakening checks.

Red:

- Characterization tests lock the current script surface and all quality gates
- Benchmark captures current cold and warm performance

Green:

- Migrate from the workspace root using the selected pinned Vite+ release
- Keep custom lint enforcement through the existing ESLint flat configuration and stable root scripts; use `vp lint`/Oxlint only after a separate rule-parity spike
- Preserve Vitest projects, coverage floors, Playwright, OpenAPI, routes, migration, docs, supply-chain, and container checks
- Keep quality-manifest gate script IDs stable and implement Vite+ behind those root scripts
- Keep Docker-, database-, integration-, supply-chain-, and Playwright-dependent tasks non-cacheable
- Bring the legacy static pipeline's Node/pnpm contract into parity or mark it as a separate rollback-only contract
- Validate runtime bundle output and sandbox startup

Exit:

- All characterization tests pass
- No gate is removed or weakened
- Cold and warm timings meet the agreed improvement threshold
- A Vite+-built bundle passes the real live-preview gate

### Milestone 4 — Nx decision spike

Goal: Decide Nx from evidence, not preference.

Compare:

- Vite+ workspace tasks and local cache
- Nx explicit tasks invoking Vite+ commands
- `nx affected`
- Remote cache across agent and CI machines
- Generator and module-boundary value

Exit:

- Adopt Nx only if measured value exceeds added configuration and maintenance
- If rejected, document why Vite+ plus template upgrade automation is enough
- Either result must pass the same sandbox and browser-verification suite

### Milestone 5 — App Studio UX

Goal: Evolve the existing workspace rather than replace it.

Extend `BuildWorkspace` and `BuildSandboxPreview` with server-authoritative states:

- Building and testing
- Allocating isolated preview
- Applying migrations
- Loading sample data
- Starting application
- Verifying in browser
- Ready
- Updating while the previous preview remains available
- Preview failed with retry
- Preview expired with restart

Add:

- Preview / Data / Blueprint / Checks / Developer details tabs
- Reuse or embed the existing `BuildOverviewTab`, `BuildPlanTab`, `BuildVerificationTab`, `BuildTimelineTab`, and `BuildPreviewTab`; map `buildRunTabList.ts` keys to inspector state
- Treat non-routed `BuildRunView` as reference-only or explicitly retire it
- Last known good revision selector
- Safe revision feedback from the existing chat composer
- Wire `BuildRevisionProgress`, `RequestChangesDialog`, and `BuildAcceptAction` into the workspace, or record the deprecation decision
- Project `detail.revision` stage, cap, and amendment state alongside preview-instance state
- Optional synthetic persona switcher after the generated-app authorization contract exists
- Data inspector limited to the isolated synthetic preview database
- Verification matrix in Checks; detailed browser evidence under Developer

Exit:

- Rewrite and unskip the existing build specs against `build-workspace-*` and `build-sandbox-*`; retire stale `BuildRunView` and `new-build-*` assertions
- Playwright covers prompt → confirmation → build → live preview → API-backed interaction → revision → atomic preview swap → accept
- Desktop, tablet, phone, keyboard, and screen-reader paths pass
- The user never needs to understand provider, lease, branch, or pipeline mechanics

### Milestone 6 — Canary, hardening, and cutover

Goal: Make live sandbox preview the Golden Stack default.

Rollout:

1. Add data model and projections without changing Phase 1 behavior
2. Shadow-create artifacts but keep static previews authoritative
3. Enable local/live mode for internal test repositories
4. Canary Azure sessions for one project
5. Require browser verification for canaries
6. Expand by repository feature flag
7. Make live sandbox mode the Golden Stack default
8. Retain static mode only for rollback
9. Replace lease-gated `isLive` and URL publication with the gateway/instance model, then deprecate the shared repository lease after the rollback window

Monitor:

- Time to first live preview
- Time from revision approval to replacement preview
- Browser verification pass rate
- Migration and seed failures
- Session allocation and leak rate
- Preview gateway errors
- Cost per active preview hour
- Cache hit rate and affected-task savings

## Initial Work Items

### Sandbox foundation

- P2-SBX-001: ADR and versioned preview manifest
- P2-SBX-002: Preview artifact, instance, and browser-check schema
- P2-SBX-003: Guard `preview_ready` and `accept`
- P2-SBX-004: `BuildPreviewProvider` and fake conformance suite
- P2-SBX-005: Deterministic runtime bundle
- P2-SBX-006: Local Docker provider
- P2-SBX-007: Full-stack migration/seed/start contract
- P2-SBX-008: Browser verifier and evidence recorder
- P2-SBX-009: Preview gateway and opaque host mapping
- P2-SBX-010: Azure Dynamic Sessions provider
- P2-SBX-011: Reconciler, TTL cleanup, quotas, and telemetry
- P2-SBX-012: Replace static settlement behind a flag
- P2-SBX-013: Preview identity adapter and launch-ticket exchange
- P2-SBX-014: Remove merge and automatic PR evidence bypasses
- P2-SBX-015: Signed runner/bundle provenance and vulnerability policy

### Golden Stack

- P2-GS-001: Baseline and Vite+ compatibility characterization
- P2-GS-002: Vite+ migration spike
- P2-GS-003: Port custom lint plugins and preserve quality parity
- P2-GS-004: Update runtime bundle and Golden Stack image
- P2-GS-005: Template version manifest and upgrade metadata
- P2-GS-006: Nx value spike
- P2-GS-007: Adopt or reject Nx by ADR

### Studio UX

- P2-UX-001: Preview lifecycle projection and user-facing copy
- P2-UX-002: Atomic last-known-good preview replacement
- P2-UX-003: Preview failure/restart experience
- P2-UX-004: Data inspector for synthetic preview data
- P2-UX-005: Blueprint and developer evidence tabs
- P2-UX-006: Persona switcher after authorization contract
- P2-UX-007: Full prompt-to-live-preview Playwright journey
- P2-UX-008: Shared client/server live-preview resolver contract
- P2-UX-009: Consolidate FEAT-008 inspector tabs and revision/accept actions

## Phase 2 Definition of Done

Phase 2 is done only when:

- A user starts from a prompt in Apex
- The Golden Stack implementation passes required red/green evidence
- An isolated full-stack application starts with PostgreSQL migrations and synthetic seed data
- The public preview passes the browser verifier
- The preview is visible inside the existing Build Workspace
- A user can mutate data and see it persist after reload
- A revision replaces the preview without blanking the previous verified version
- Cancel and TTL destroy the session and revoke the URL
- Accept is refused if the current preview evidence is missing or stale
- The same provider conformance and Playwright suites pass locally and in Azure

## Decision Defaults Pending Confirmation

- Production provider: chosen after the Dynamic Sessions protocol spike; Dynamic Sessions is the preferred pilot
- Fallback provider: regular Azure Container Apps for trusted workloads or Azure Container Apps Sandboxes where available
- Local provider: Docker
- Preview visibility: requester and project viewers only
- Preview identity: synthetic preview principal
- Outbound network: denied by default
- Session scope: one session per build revision
- Prior preview: remain live until replacement is verified
- Static preview: rollback-only legacy mode
- Vite+: adopt after parity spike
- Nx: decide after the live-preview walking skeleton and a measured spike

## Public References

- Base44 cloud sandbox: https://docs.base44.com/developers/app-code/sandbox/overview
- Base44 app code overview: https://docs.base44.com/developers/app-code/overview/introduction
- Azure Container Apps Dynamic Sessions: https://learn.microsoft.com/en-us/azure/container-apps/sessions
- Azure custom container sessions: https://learn.microsoft.com/en-us/azure/container-apps/sessions-custom-container
- E2B runtime architecture: https://github.com/e2b-dev/infra/blob/main/docs/ARCHITECTURE.md
- Vite+ migration: https://viteplus.dev/guide/migrate
- Vite+ task caching: https://viteplus.dev/guide/cache
- Nx affected tasks: https://nx.dev/docs/features/ci-features/affected
- Nx remote caching: https://nx.dev/docs/features/ci-features/remote-cache
