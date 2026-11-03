---
name: Playbook Product Expansion — Part 1
overview: First of two plans. Makes every Playbook node a checked contract, enforces what agent steps can do, stores and shows step output, and gives authors a real edit page. Part 2 builds templates, triggers, actions, and parallelism on this.
status: proposed
part: 1
continues_in: design-docs/playbook-product-expansion-part-2.plan.md
scope:
  - Node contracts, binding checks, and step-type schema compatibility
  - Runtime capability enforcement for cursor-agent steps
  - Large step-output storage, hydration, and one step-detail view
  - Playbook edit page for details, versions, and advanced graph JSON
  - Pinned-upgrade practice for Mastra, React Flow, and elkjs
out_of_scope:
  - Additional interview specialists
  - Ordered-list authoring fallback
  - Template catalog, triggers, action nodes, connectors, parallelism, authoring recommender, and SkillOpt (Part 2)
---

# Playbook Product Expansion — Part 1: Runtime foundation

Part 2 is `design-docs/playbook-product-expansion-part-2.plan.md`. Do not start Part 2 until this
plan's acceptance criteria are met. Part 2 assumes the contracts in this document already exist.

## Why this plan is first

Templates, unattended triggers, action nodes, and parallel arms all copy or multiply today's
Playbook run. Shipping them first would spread four weaknesses:

1. A binding can name a step that never runs before it, or a field that type does not return.
2. A `cursor-agent` step's read-only label is not enforced on native tools or the working directory.
3. Step output is inline only, and the live run hides it, so nobody can see what a node did.
4. Name, description, versions, and raw graph JSON sit in disclosures at the bottom of the
   dashboard, which is the wrong home for the controls Part 2 will add.

This plan fixes those, in that order. Each chunk is one idea. Later chunks use the earlier ones.

| Order | Chunk | What it makes true |
| --- | --- | --- |
| 1 | Node contract | A node declares what it needs and returns. Publish proves the bindings. |
| 2 | Capability enforcement | An agent step runs only the frozen policy Apex resolved. |
| 3 | Output and inspection | Large output is stored, bindings read it, and one drawer shows the step. |
| 4 | Edit page | Dashboard is for status. Editing lives on its own page. |
| 5 | Dependency hygiene | Mastra, React Flow, and elkjs stay on tested pins. |

Chunk 5 can proceed beside chunk 1. It must be green before Part 2 changes the engine or the canvas.

## Product outcome

After this plan:

- An author cannot publish a binding that points at the wrong step or a missing field.
- A step type means the same thing in every project. Breaking changes carry a schema version.
- A published agent step has an auditable capability policy, and workers enforce it.
- A large report does not bloat PostgreSQL, and branches still see the full output.
- Clicking a node on the canvas or the live run opens the same detail: status, resolved input,
  safe output, and the agent activity when the step is a `cursor-agent`.
- Edit opens a page with details, versions, and an advanced JSON escape hatch.

## What Part 2 is allowed to assume

- `${input.*}` and `${steps.<stepId>.<field>}` are the only data path. There is no implicit
  "previous node" channel.
- Publish rejects a binding whose source is not an ancestor, or whose field is absent from that
  type's output schema at the schema version the graph pinned.
- `playbookExecutionCapabilityService` is the only capability resolver. Workers consume a frozen
  `PlaybookAgentRunPolicy` and do not invent defaults.
- `playbookStepOutputStore` is the only writer and reader of step output. Bindings and branches
  load logical output through it.
- `PlaybookStepDetailDrawer` is the only step inspection surface. New step types add a summary
  renderer. They do not add a new page.
- `/playbooks/:definitionId/edit` exists, with Details, Versions, and Advanced. Part 2 adds its own
  sections there.
- `@mastra/core`, `@mastra/pg`, `@xyflow/react`, and `elkjs` remain exact pins, upgraded only
  through the runbook in chunk 5.

## Scope boundaries

This plan does not add interview specialists or an ordered-list editor.

This plan does not build the template gallery, trigger subscriptions, `apex-action`, connectors,
parallel splits, joins, loops, the authoring recommender, or a SkillOpt pilot. Those are Part 2.
Their design is already accepted. They wait on the contracts above.

This plan does not replace Mastra or add another workflow engine.

## Current foundation

- Project-owned definitions, retained drafts, and immutable published versions.
- Runs pinned to one published version.
- A closed step registry: `cursor-agent`, `approval-gate`, `notify`, `ingest-artifact`, `branch`,
  `interview`. Descriptors carry Zod input and output, side effect, permissions, and deadline.
- Bindings are data, not expressions: `input.<field>` and `steps.<stepId>.<field>`.
- Graph guards reject joins, cycles, and fan-out wider than one edge, except a branch's two arms.
- `playbook_step_runs.output_inline` and the reserved `output_blob_ref` column.
- Mastra is loaded only inside `src/server/services/playbookEngine/` and decides which step runs
  next. Apex writes every step row.
- Exact pins: `@mastra/core` 1.67.0, `@mastra/pg` 1.25.0, `@xyflow/react` 12.12.0, `elkjs` 0.12.0.
- The canvas inspector edits config. `PlaybookRunStepList` shows id, type, status, and time, and
  hides output.
- The dashboard Manage section holds versions and the draft JSON editor.

## Decisions

### D1 — Data flow is explicit

Edges decide control flow. Bindings decide data flow. A node never receives "whatever the previous
node returned."

Publish checks every `steps.<stepId>.<field>` placeholder:

- `stepId` is on the graph;
- that node can run before the node holding the placeholder, by following edges backward;
- `field` is a top-level key of that step type's output schema at the pinned schema version.

A branch condition's `sourceStepId` and an approval gate's `gatedStepId` use the same ancestor
rule they already have, plus the field check for branch conditions.

### D2 — Projects do not version or fork step types

Authors version the Playbook. The base step type stays one shared definition.

Engineers change a type under these rules:

- Adding an optional field needs no schema bump.
- Renaming, removing, or changing the meaning of a field bumps `schemaVersion` on the descriptor.
- Publish stamps each node's `stepType` and `schemaVersion` into the immutable version.
- A run validates and executes against the stamped version. The current adapter must still accept
  that version. If it cannot, publish of new graphs moves forward and old runs keep the previous
  adapter behavior behind an explicit version branch in that one adapter.

End users never get a private copy of `notify` or `cursor-agent`.

### D3 — Capability policy is resolved by Apex and frozen for workers

The App Service resolves the Skill declaration, project settings, repository grounding, MCP
descriptors, and local tool policy. It writes one immutable `PlaybookAgentRunPolicy` into the
agent-run snapshot or V2 execution specification.

Workers execute that policy. They do not invent defaults or reevaluate project policy.

The closed capability vocabulary is:

- `repository-read`
- `repository-write`
- `network-read`
- `external-write`
- `secret-use`
- `browser-use`
- `deployment`

### D4 — Read-only applies to native tools as well as MCP

A read-only profile constrains MCP servers, SDK-native write tools, custom tools, the working
directory, and any worker-side fallback. An empty MCP map is not read-only.

`external-write` still requires the existing approval-gate rule for `leaves-apex` steps.

### D5 — Step outputs spill at 32 KiB by default

A validated output is canonical JSON, measured in UTF-8 bytes.

- At or below 32 KiB: store the full output in `output_inline`.
- Above 32 KiB: store a small typed summary inline and the full output in Blob Storage.

`PLAYBOOK_STEP_OUTPUT_INLINE_MAX_BYTES` may override the threshold. The default is 32,768 until
production measurements justify a change.

### D6 — One private container, one logical reader

The container is `playbook-step-outputs` in the existing per-environment shared Storage Account.
The key is `{project}/{runId}/{stepRunId}/output-v1.json`. The container is private. The browser
reads output through an authenticated Apex route.

Bindings, branches, and the step drawer all load output through `playbookStepOutputStore`. Run
list polling returns the summary and blob metadata only.

### D7 — One step drawer

Canvas selection and the live run open `PlaybookStepDetailDrawer`. It shows status, timing,
config after bindings resolve, a safe output summary, and the existing agent activity timeline for
`cursor-agent`. Full body download uses the output route. Per-type renderers plug into this drawer.
Part 2's cloud-agent activity stream plugs into the same drawer.

### D8 — Edit is a page

`/playbooks/:definitionId/edit` has three areas:

- Details: name and description
- Versions: the current version list and deprecation actions
- Advanced: draft graph JSON, labeled as an escape hatch

The dashboard keeps status, outline, recent runs, and history. `playbooks:author` sees Edit.
Viewers do not. This change does not need a feature flag. It does not change how a run executes.

### D9 — Engine and canvas packages stay pinned

Do not float `@mastra/core`, `@mastra/pg`, `@xyflow/react`, or `elkjs`. There is no Dependabot or
Renovate config, and this plan does not add one that auto-merges.

Upgrade those packages only in a dedicated branch, using the runbook in chunk 5. Mastra upgrades
are separate from canvas upgrades.

## Chunk 1 — Node contract

### Design

Add `schemaVersion` to `PlaybookStepTypeDescriptorBase`. Every current descriptor starts at `1`.

Stamp onto each node when a version is published:

```ts
interface PlaybookPublishedNodeStamp {
  stepType: string;
  schemaVersion: number;
}
```

Store the stamp map on the immutable version next to the graph. Draft nodes do not need a stamp.
Publish writes it.

`playbookBindingResolver` already accepts only `input.<field>` and `steps.<stepId>.<field>`.
Add `assertBindingsResolvable(graph)` and call it from `assertGraphWithinGuards` and from the
canvas connection check when the author asks to validate. The canvas may still save an unfinished
draft. Publish may not.

The check walks edges backward from the node that holds the placeholder. A branch arm counts as
an ancestor only for nodes that follow that arm. A binding from the false arm to a step that exists
only on the true arm fails publish.

Output-field checks use the Zod output schema's top-level keys. Nested fields are out of scope
until a step type actually returns a nested object that authors bind into. Today's outputs are flat
except `scorecard`, which stays a single bound value.

### Author experience

The inspector, which already builds fields from the input schema, gains a short "Reads" line listing
the bindings in this node's config and whether each one resolves. Publish errors name the node, the
placeholder, and the reason: unknown step, step is not before this one, or unknown field.

### Tests

- A binding to a later step fails publish and names both nodes.
- A binding to a field absent from the output schema fails publish.
- A binding to run input still passes.
- An optional new field does not change `schemaVersion`.
- A published version keeps schema version 1 after the descriptor moves to version 2.
- Two projects cannot install different definitions of the same step type, because there is still
  one registry.

## Chunk 2 — Capability enforcement

### Design

`playbookExecutionCapabilityService` is the canonical resolver.

It loads the pinned Skill, parses the Apex capability declaration in that Skill, resolves the
server-owned execution profile, freezes MCP descriptors and repository grounding, and refuses a
request broader than the Skill and the project allow. It returns a versioned policy and a
human-readable explanation for dry run and publish.

```ts
interface PlaybookAgentRunPolicy {
  schemaVersion: 1;
  resolverVersion: number;
  executionProfile: string;
  capabilities: PlaybookCapability[];
  skill: { path: string; sha256: string };
  repository?: {
    provider: 'github' | 'azure-devops';
    repository: string;
    groundedSha?: string;
  };
  mcpServers: FrozenInteractiveMcpDescriptor[];
  localAgent: {
    cwdMode: 'scratch' | 'repository';
    allowBuiltinWrites: boolean;
    customTools: 'none' | 'native-read-only';
  };
  resolvedAt: string;
}
```

Reuse the existing frozen MCP descriptor type when its meaning matches. Do not create a second
frozen MCP contract only because the caller is a Playbook.

The cursor-agent inspector replaces free-text profile entry with the server-provided list. Each
option states capabilities, MCP access, repository grounding, native write behavior, and whether an
approval gate is required.

Publish blocks when policy cannot be resolved. Dry run reports the same result with kind
`capability`. While the flag is off, Apex still writes the policy snapshot so enforcement can be
compared before it is turned on. When the flag is on, a missing or invalid policy aborts that
agent step with an actionable terminal error.

V1 and V2 workers apply the frozen policy. Read-only denies native write tools and a writable
repository working directory, not only MCP.

The Phase 0 Skill allow-list remains until enforcement has been on for the cleanup window. It then
becomes the emergency brake, not the capability model.

### Flag

`playbooks-capability-enforcement`, default off.

Remove it after every enabled template and project Skill has a valid declaration, every active
worker version enforces the frozen policy, and two stable sprints show no legacy fallback.

### Tests

- The same node resolves to the same policy in publish, dry run, V1 enqueue, and V2 routing.
- Policy snapshots contain no credentials.
- A read-only policy cannot write through MCP, native tools, custom tools, or the working directory.
- V1 and V2 match.
- With the flag on, a missing policy aborts the step.
- With the flag off, old published versions still run, and new runs still record a snapshot.

## Chunk 3 — Output and inspection

### Design

`playbookStepOutputStore` owns canonical serialization, byte measurement, summary construction,
upload, SHA-256, reference creation, full-output load, authorized part extraction, and deletion.

Blob body:

```ts
interface PlaybookStepOutputEnvelope {
  schemaVersion: 1;
  project: string;
  runId: string;
  stepRunId: string;
  stepId: string;
  stepType: string;
  completedAt: string;
  output: Record<string, unknown>;
}
```

`output_blob_ref` stores:

```ts
interface PlaybookStepBlobRef {
  schemaVersion: 1;
  container: string;
  key: string;
  sha256: string;
  sizeBytes: number;
  contentType: 'application/json';
}
```

Upload the blob before the conditional database write. Keys are deterministic per step run. A
retry deletes the superseded object. A sweep reports orphan blobs and dangling references. It
never deletes a blob that a retained step row names.

`GET /api/playbooks/runs/:runId/steps/:stepRunId/output?project=&part=full` requires
`playbooks:view`, checks project, run, and step ownership, and verifies the checksum before
returning bytes. The first parts are `full`, `reportMd`, and `scorecard`. The route does not
return a public blob URL.

### Drawer

`PlaybookStepDetailDrawer` opens from canvas node selection and from a live-run step row.

It shows:

- status, start, and finish;
- config after `resolveRunStepConfig`;
- inline summary, size, and checksum status;
- Preview and Download when the caller has `playbooks:view`;
- the existing agent activity timeline when `stepType` is `cursor-agent`;
- suspension detail when this step is the parked step.

Polling the run never downloads the blob. The drawer loads output only when opened.

Agent transcripts stay behind the same project permission as the run. The summary shown in the
list is the small inline summary, not the transcript.

### Flag

`playbooks-step-output-artifacts`, default off. The drawer ships behind the same flag, because the
resolved-output view is the reason the store exists.

Remove the flag after reconciliation reports no dangling references or unbounded orphans for two
stable sprints, and every consumer uses the logical output loader.

### Infrastructure

The container and role assignment belong in Terraform, and the scheduler for orphan cleanup starts
from the server process. Those files require explicit implementation approval when this chunk
starts. This plan does not authorize that edit by itself.

### Tests

- Small outputs remain inline.
- Large outputs survive restart and hydrate for a binding and a branch.
- Behavior above and below the threshold matches for branch evaluation.
- Polling responses contain no blob body.
- A project mismatch returns no metadata and no body.
- Duplicate completion leaves one logical output.
- A blob written without a database reference is reported and removed.
- A database reference whose blob fails checksum is reported and not served.

## Chunk 4 — Edit page

### Design

Add Edit on the dashboard header when the caller has `playbooks:author`. The button routes to
`/playbooks/:definitionId/edit`.

Move `PlaybookVersionList` and `PlaybookDraftEditor` onto that page unchanged in behavior.

- Details saves name and description through the existing draft update.
- Versions keeps publish, deprecate, and history actions that already exist.
- Advanced keeps the graph JSON editor and states that the canvas is the editor authors should use.

Remove the Manage section from `PlaybookDashboardPage`.

Leave room in the page layout for Part 2 sections. Do not add those sections here.

### Tests

- A viewer does not see Edit and cannot open the edit route's mutating actions.
- An author can rename, edit the description, and save graph JSON.
- Saving JSON still runs the draft graph validation.
- The dashboard no longer renders the Manage disclosures.
- Browser check: dashboard, edit page, and canvas still agree on the draft after a save.

## Chunk 5 — Dependency hygiene

### Current pins

| Package | Pin | What breaks if it moves unseen |
| --- | --- | --- |
| `@mastra/core` | 1.67.0 | Which step runs next, suspend, and resume. The workflow object is thenable. A change to `.then` can hang a run with no error. |
| `@mastra/pg` | 1.25.0 | The engine's own Postgres store. |
| `@xyflow/react` | 12.12.0 | Canvas selection, edges, and node measurement. |
| `elkjs` | 0.12.0 | Automatic layout. Nodes can move without a data test failing. |

### Runbook

1. Upgrade one family per branch: Mastra core and pg together, or xyflow and elkjs together.
2. Keep the versions exact in `package.json`.
3. For Mastra, run the engine conformance suite, suspend and resume tests, and one real Playbook
   start through an approval gate.
4. For the canvas packages, run the canvas unit tests and check the builder in the browser:
   add a node, connect it, auto-layout, save, reload.
5. Record the new pin and the date in the engine verification note or the canvas spike note,
   whichever package moved.

Do not add an auto-merge bot in this plan. A scheduled human review, or a review when a security
advisory appears, is the maintenance cadence.

## Delivery order

### Wave 1 — Node contract

Schema version on descriptors, publish stamps, binding ancestor and field checks, inspector
"Reads" line, tests.

Exit: a bad binding cannot publish. Existing valid graphs still publish. Schema version 1 is
stamped on new versions.

### Wave 2 — Capability snapshots

Resolver, Skill declaration, execution profiles, snapshot on V1 and V2 specs, dual-write while the
flag is off, publish and dry-run results, inspector selector.

Exit: one node, one policy, in every caller. Snapshots contain no credentials.

### Wave 3 — Worker enforcement

Worker checks, frozen MCP, native-tool denial, working-directory restriction, audit evidence,
flag default off.

Exit: read-only cannot write. Flag on aborts a missing policy. Flag off still runs old versions.

### Wave 4 — Output store

Container and local store, threshold, checksum, logical loader for bindings and branches,
authenticated route, redaction of polling payloads.

Exit: large and small outputs behave the same for branches and bindings.

### Wave 5 — Drawer and cleanup

Step drawer on canvas and live run, agent activity for `cursor-agent`, orphan and dangling-reference
sweep.

Exit: opening a step shows resolved input and a safe summary. Polling does not download blobs.
Cleanup never deletes a referenced blob.

### Wave 6 — Edit page

Route, move versions and JSON, remove dashboard Manage, browser check.

Exit: authors edit on the edit page. The dashboard is status, runs, and history.

### Wave 7 — Dependency runbook

Write the runbook down in the verification doc that already tracks the Mastra pin. Take no upgrade
unless an advisory or a Part 2 engine change requires it. If an upgrade is required, it lands
before the Part 2 work that needs it.

## Testing strategy

Unit tests cover binding checks, schema stamps, policy compatibility, threshold and checksum,
and summary redaction.

Route tests cover output ownership, the capability flag's off and on paths, and edit-page
permissions.

Integration tests cover a real cursor-agent enqueue that persists policy, a large output round
trip through a branch, and orphan cleanup.

Browser tests cover the drawer and the edit page. They run in CI.

## Security and privacy

- Policy snapshots contain grants and descriptors, never credentials.
- Output routes are project-scoped and checksum-checked.
- No public blob URL.
- List and polling payloads omit output bodies.
- Logs omit Skill bodies and output bodies.
- Workers abort when enforcement is on and policy cannot be evaluated.

## Reliability

- Invalid bindings fail at publish, before a run starts.
- Blob upload precedes the database reference.
- Cleanup is idempotent.
- A null `output_blob_ref` means inline-only, including rows written before this plan.
- Workers treat a frozen policy as immutable.

## Observability

Record policy resolution outcome by profile and reason, policy-missing rejections, inline versus
spilled output counts and bytes, upload latency, checksum failures, orphans, and dangling
references.

## Rollout

1. Ship both flags off.
2. Stamp schema versions and enforce binding checks for newly published versions. Existing
   published versions stay runnable.
3. Dual-write capability snapshots and measure output sizes.
4. Enable capability enforcement on Apex-owned read-only Playbooks.
5. Enable output spill and the drawer on the Apex project.
6. Ship the edit page to everyone who can already author.
7. Expand project targeting after two stable sprints at each flag.

Rollback:

- Binding checks apply to new publishes. Unpublish is not required to roll back.
- Capability flag off returns workers to the previous execution path during rollout.
- Output flag off keeps new output inline and still reads any blob references already written.
- The edit page rollback is returning the two editors to the dashboard. Draft data is unchanged.

## Migration

- No template or trigger tables in this plan.
- `output_blob_ref` stays JSONB. The Drizzle type becomes `PlaybookStepBlobRef`.
- Published-node schema stamps need a version-metadata field if one does not already hold arbitrary
  JSON. Prefer the existing version row over a new table.
- Feature-flag rows for the two flags.
- The blob container is Terraform, not SQL.

## Files

### New

- `src/shared/types/playbookExecutionCapability.ts`
- `src/server/services/playbookExecutionCapabilityService.ts`
- `src/server/services/playbookStepOutputStore.ts`
- `src/server/services/playbookStepOutputCleanupService.ts`
- `src/client/components/PlaybookStepDetailDrawer.tsx`
- `src/client/components/PlaybookEditPage.tsx`

### Existing, expected to change

- `src/shared/types/playbook.ts`
- `src/server/services/playbookSteps/registry.ts`
- `src/server/services/playbookBindingResolver.ts`
- `src/server/services/playbookStepBindings.ts`
- `src/server/services/playbookGuardService.ts`
- `src/server/services/playbookSteps/branchAdapter.ts`
- `src/server/services/playbookSteps/cursorAgentAdapter.ts`
- `src/server/services/playbookSteps/stepRuns.ts`
- `src/server/services/playbookMcpCapabilityService.ts`
- `src/server/services/playbookRunProjectionService.ts`
- `src/server/services/agentRunLifecycleService.ts`
- `src/server/services/backgroundWorkflowRouter.ts`
- `src/server/services/aiRunsWorker/cursorExecution.ts`
- `src/server/services/aiRunsV2Worker/documentExecution.ts`
- `src/server/routes/playbooks.ts`
- `src/server/db/schema.ts`
- `src/client/App.tsx`
- `src/client/components/PlaybookDashboardPage.tsx`
- `src/client/components/PlaybookCanvasPage.tsx`
- `src/client/components/PlaybookStepInspector.tsx`
- `src/client/components/PlaybookDryRunPanel.tsx`
- `src/client/components/PlaybookRunStepList.tsx`
- `src/client/components/PlaybookLiveRunPage.tsx`
- `.cursor/CODEMAP.md` when a top-level path or a listed path changes

### Needs explicit approval at implementation time

- `infra/shared-async.tf` and related Terraform for `playbook-step-outputs`
- App Service settings for the container name
- `src/server/index.ts` if the cleanup sweep must start with the process

## Work items

### Epic A — Node contract

- NOD-001: `schemaVersion` on descriptors, default 1
- NOD-002: stamp schema versions onto the immutable published version
- NOD-003: ancestor and output-field binding checks at publish
- NOD-004: inspector Reads line and actionable publish errors
- NOD-005: tests for cross-arm bindings and old published versions

### Epic B — Capability enforcement

- CAP-001: capability vocabulary and Skill declaration
- CAP-002: server-owned execution profiles
- CAP-003: resolver and compatibility errors
- CAP-004: pin policy on V1 snapshots and V2 specifications
- CAP-005: publish and dry-run evaluation
- CAP-006: inspector selector
- CAP-007: enforce MCP, native tools, and working directory in the V1 worker
- CAP-008: enforce the same policy in the V2 worker
- CAP-009: audit evidence and conformance tests
- CAP-010: flag, dual-write, and rollout

### Epic C — Output and inspection

- OUT-001: measure current output sizes and confirm 32 KiB
- OUT-002: envelope and blob-reference contracts
- OUT-003: shared container and local store
- OUT-004: persist, checksum, and logical load for bindings and branches
- OUT-005: authenticated output route and polling redaction
- OUT-006: step drawer, including cursor-agent activity
- OUT-007: retry cleanup and orphan reconciliation
- OUT-008: flag, integration tests, and rollout metrics

### Epic D — Edit page

- EDT-001: edit route and author gate
- EDT-002: move details, versions, and graph JSON
- EDT-003: remove dashboard Manage
- EDT-004: browser test across dashboard, edit page, and canvas

### Epic E — Dependency hygiene

- PIN-001: record the upgrade runbook beside the current Mastra verification note
- PIN-002: take a pin upgrade only when an advisory or a required engine fix says so

## Acceptance criteria

1. Newly published graphs reject bindings to non-ancestors and unknown output fields.
2. Step types remain a single registry. Published versions record the schema version they passed.
3. Every newly published `cursor-agent` step has a frozen policy with no credentials in it.
4. Read-only policy is enforced on V1 and V2 for MCP, native tools, and the working directory.
5. Large output matches inline output for bindings, branches, retries, and restarts.
6. Output bodies are private, checksum-checked, and absent from polling payloads.
7. The canvas and the live run open one drawer that shows resolved input and a safe summary.
8. Authors edit name, description, versions, and graph JSON on the edit page, and the dashboard
   no longer carries Manage.
9. Mastra, xyflow, and elkjs are still exact pins, and the upgrade runbook is written down.

## Open decisions

1. Is 32 KiB the right threshold after the measurement in OUT-001?
2. Where on the existing version row should the schema-version stamp live?
3. Which current Skills get a capability declaration in the first enforcement cohort?

Do not infer these during implementation. The measurement decides the first. The version-row
shape decides the second. The Skill owners decide the third.

Part 2 starts only after the acceptance criteria above are true in the Apex project.
