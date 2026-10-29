---
name: Playbook Product Expansion — Part 2
overview: After the runtime foundation, adds template reuse, unattended triggers, deterministic action nodes and connectors, parallel joins and bounded loops, and an authoring recommender. SkillOpt is Part 3.
status: proposed
part: 2
requires: design-docs/playbook-product-expansion.plan.md
continues_in: design-docs/playbook-product-expansion-part-3.plan.md
scope:
  - Source-controlled Playbook template catalog
  - Schedules, Apex events, signed webhooks, and Azure DevOps triggers
  - Apex action nodes, a connector model, and a cloud-agent step wrapped over the existing service
  - Parallel splits, joins, and bounded loops
  - An authoring recommender for existing step types
out_of_scope:
  - Additional interview specialists
  - Ordered-list authoring fallback
  - Runtime node registration
  - User-forked step types
  - Free-drawn graph cycles
  - A public connector marketplace
  - SkillOpt (Part 3)
---

# Playbook Product Expansion — Part 2: Composition and automation

Part 1 is `design-docs/playbook-product-expansion.plan.md`. Start this plan only after Part 1's
acceptance criteria are met. This plan does not reopen node contracts, capability enforcement,
the output store, the step drawer, or the edit page. It uses them.

## Why this order

Part 1 makes a single Playbook run explicit, limited, and inspectable. This plan makes Playbooks
reusable and able to do more than a straight line of the current six step types. The chunks are
ordered so each one has somewhere to stand.

| Order | Chunk | Depends on | What it adds |
| --- | --- | --- | --- |
| 1 | Template catalog | Part 1 contracts, capabilities, and edit page | Install a vetted graph as a project-owned draft. |
| 2 | Triggers | Part 1 run path and edit page. Chunk 1 is not required. | Start that same run from a schedule or an Apex event, then from outside Apex. |
| 3 | Actions and connectors | Part 1 bindings, side-effect rules, and drawer. Chunk 2's inbound events. | Deterministic Apex operations, outbound connectors, and a cloud-agent step. |
| 4 | Parallel, join, and bounded loop | Part 1 bindings, output loader, and agent caps. Chunk 3 so a loop can call an action. | More than one arm, a join, and a loop with a maximum. |
| 5 | Author assistance | Chunks 1 and 3 for the recommender. | Recommend an existing step type. |

Chunks 1 and 2 may proceed in parallel once Part 1 is done. Chunk 3 should finish before chunk 4.
Chunk 5 starts after chunk 3. SkillOpt is not in this plan.

## Product outcome

A Playbook author can:

- browse vetted templates and install one as a project-owned draft;
- apply a newer template version only by confirming a draft replacement;
- start a published Playbook from a schedule or an allow-listed Apex event;
- see every trigger receipt, duplicate, retry, and dead letter;
- drop in an action that creates work items, comments, or sets a document status without a model call;
- start the existing My Work cloud agent from a Playbook, behind an approval gate;
- run several arms at once, join them, or repeat a body up to a fixed maximum;
- ask which existing step type fits a goal, and get a config for that type.

An administrator can pause automation without unpublishing a Playbook, and can grant trigger
administration separately from authoring.

## What this plan assumes from Part 1

- Bindings are checked at publish against ancestors and output fields.
- Step types are a closed registry with schema versions. This plan adds types by pull request.
- Agent steps carry a frozen capability policy, and workers enforce it.
- Step output is loaded through `playbookStepOutputStore`.
- `PlaybookStepDetailDrawer` is the inspection surface. New types add a summary renderer.
- The edit page exists at `/playbooks/:definitionId/edit`.
- Mastra, xyflow, and elkjs are exact pins. Parallelism changes the engine translator, so any
  Mastra upgrade required for parallel or join support lands through the Part 1 runbook first.

## Scope boundaries

This plan does not add interview specialists or an ordered-list editor.

This plan does not let a skill register a step type at runtime, and it does not let a project fork
a private version of a step type.

This plan does not allow an edge that points backward. Loops are a step type with `maxIterations`.

This plan does not add a second run-start path. Triggers call `startRun`.

This plan does not use Service Bus. Trigger dispatch stays in PostgreSQL until a measured scale
problem says otherwise.

## Decisions

### D1 — Templates are source-controlled copies

The catalog is a repository manifest plus graph files. It is not a table of shared mutable
definitions.

Install creates or returns a project-owned definition and draft. A project may edit that draft.
Shipping a new template version never changes project drafts, published versions, or active runs.

### D2 — Template upgrades are explicit

Each template has a stable `templateKey` and an increasing `templateVersion`.

Applying an update requires `playbooks:author`, the same template key, the current draft revision,
and a confirmation that the draft graph will be replaced. The author publishes afterward.

### D3 — The first templates use step types that already exist

The first catalog entries use `cursor-agent`, `approval-gate`, `notify`, `branch`, `interview`,
and `ingest-artifact`. Design Doc validation is the preferred second template, beside the existing
interview template.

A template that uses `apex-action`, a cloud-agent step, or a parallel region waits until those
types exist. The catalog does not block on them.

### D4 — Triggers start ordinary runs

A trigger writes a receipt, resolves an explicit initiator and input, and calls `startRun`.

It does not skip version resolution, graph guards, active-run limits, spend admission, capability
policy, step permission checks, or reconciliation.

The initiator is a user stored on the subscription. Dispatch rechecks `playbooks:run` and the step
permissions. The person who caused the Apex event is audit data and may be mapped into input. That
person does not silently become the initiator.

### D5 — "Anything in Apex" is an event catalog

Features do not start Playbooks by calling the engine. They publish a typed event. A subscription
chooses the event.

The first events are product moments that already exist:

- design-doc validation requested
- interview brief completed
- document approved
- feature request triaged
- cloud-agent run finished

A database trigger on every table is out of scope. New events are added to the catalog on purpose.

### D6 — Internal triggers ship before external ones

The first trigger kinds are manual test fire, UTC schedule, and an allow-listed Apex event.

Signed webhooks, API-key submission, and Azure DevOps service hooks start only after internal
idempotency, retries, dead letters, and the receipt UI have been used for real.

### D7 — PostgreSQL is the trigger queue

Receipts hold pending, retry, and dead-letter state. A jittered scheduler claims due work under an
advisory lock. `LISTEN/NOTIFY` may wake the process later. It is not the delivery guarantee.

### D8 — Actions are allow-listed operations

One new step type, `apex-action`, names an operation and a config object for that operation.
Bindings fill the object. The operation list is code, not author-defined script.

The first operations are:

- `create-ado-items`
- `post-ado-comment`
- `set-document-status`

Each operation declares its own permissions and side effect. An operation that leaves Apex stays
behind an approval gate.

There is no node that runs arbitrary code against the previous output.

### D9 — Connectors split inbound and outbound

A connector is a named integration with a secret reference, inbound events, and outbound operations.
It is not a marketplace.

- Inbound events are trigger sources. They use the trigger receipt path.
- Outbound operations are `apex-action` operations or a dedicated step type when the lifecycle is
  too large for one operation.

Teams is the first outbound connector, because `notify` already calls a Teams webhook and must
still finish when that webhook is unset. Generalize that call behind the connector interface.
Do not rebuild it.

Clerk and PagerDuty wait until a workflow needs them. Clerk fits user lifecycle events.
PagerDuty fits "page someone" as an action and "incident opened" as a trigger.

### D10 — Cloud agent is a wrapper, not a second client

A `cloud-agent` step calls a function extracted from `cloudAgentService.startCloudAgentRun`.
It does not create another Cursor SDK client.

The step passes work item, repository, and prompt through bindings. It reuses the feature-flag
check, skill-repo settings, live-run conflict rule, private prompt blob, queue, cancel, pull
request, and leftover-work behavior. The step is `leaves-apex` and requires an approval gate.
The step drawer renders the existing cloud-agent activity stream.

### D11 — Parallelism is bounded

Three graph features, and no free cycles:

1. A parallel split starts every outbound arm.
2. A join waits for named arms under a policy of all-succeeded or a stated minimum. Its output is
   a map keyed by step id, so downstream bindings stay explicit.
3. `foreach` and `until` are step types with `maxIterations`. Each iteration is a durable step run
   and counts toward the agent cap and spend checks.

An edge that points backward still fails publish.

### D12 — The recommender does not invent types

The authoring assistant reads a draft and a goal and returns an existing `stepType` plus a config
that passes that type's input schema. When no type fits, it says so and describes the gap. It does
not write a descriptor, an adapter, or a graph full of private node types.

## Chunk 1 — Template catalog

### Design

Add `src/server/playbookTemplates/catalog.json`. `playbookTemplateCatalogService` loads and
validates it. `playbookTemplateService` keeps graph loading, install, and explicit apply-to-draft.

```ts
interface PlaybookTemplateCatalogEntry {
  templateKey: string;
  templateVersion: number;
  displayName: string;
  summary: string;
  category: string;
  tags: string[];
  graphFile: string;
  requiredFlags: string[];
  requiredPermissions: string[];
  installPolicy: 'one-per-project';
  runInputSchema?: Record<string, unknown>;
  estimatedCostBand?: 'low' | 'medium' | 'high';
}
```

Install state is derived, not stored separately: `not-installed`, `draft-only`, `published`, or
`update-available`. Existing `template_key` and `template_version` columns remain the provenance.

### APIs

- `GET /api/playbooks/templates?project=` requires `playbooks:view` and `playbook-template-catalog`.
- `GET /api/playbooks/templates/:templateKey?project=` returns the detail and a graph preview.
- `POST /api/playbooks/templates/:templateKey/install` requires `playbooks:author` plus the
  template's required flags. It creates or returns an unpublished project definition.
- `POST /api/playbooks/definitions/:definitionId/apply-template` requires author, template key,
  target version, expected draft revision, and confirmation. It replaces the draft graph only.

Installed graphs pass Part 1's binding and capability checks at publish. The catalog does not
bypass them.

### Experience

The Playbooks manage page gains New blank Playbook and Browse templates. A card shows purpose,
tags, step summary, required flags, permissions, cost band, install state, and whether an update
exists.

Install opens the definition dashboard. The author reviews and publishes through the current flow.
An update banner on the edit page opens a comparison and the confirmation. The first comparison
may be graph JSON and a step summary. A visual diff is optional.

### Flag

`playbook-template-catalog`, default off. Remove it after target projects have had the catalog on
for two stable sprints and installs show no unresolved compatibility failures.

### Tests

- Two projects install independent copies.
- A template update does not change a published version or an active run.
- A template whose bindings fail Part 1 checks cannot publish, and the error names the node.
- Required flags and capabilities are visible before install.
- Install and apply are audited.

## Chunk 2 — Triggers and inbound connectors

### Data model

`playbook_trigger_subscriptions` holds project, definition, name, enabled, kind, schedule,
event type and filter, version policy (`current_published` or `pinned`), pinned version, initiator
user, run-input template, declarative input mapping, concurrency policy (`allow` or
`skip_if_active`), dedupe key template, and audit columns.

The first release allows `schedule` and `apex_event` only. `webhook` and `azure_devops` are added
in the external wave.

`playbook_trigger_receipts` holds subscription, idempotency key, source, payload hash, payload,
status (`pending`, `started`, `skipped`, `retryable`, `failed`, `dead_letter`), run id, attempts,
next retry, and error. The unique key is `(subscription_id, idempotency_key)`.

`playbook_runs` gains nullable `trigger_subscription_id` and `trigger_receipt_id`.

### Input mapping

Mapping is declarative. It supports a literal, `event.entityId`, `event.actorUserId`,
`event.data.<field>`, and a static value from the run-input template. It does not evaluate
JavaScript, JSONata, or a template language.

Subscription validation uses Part 1's binding rules and reports required run inputs the mapping
cannot produce.

### Event catalog

`playbookApexEventService` is the publisher. The Design Doc validation path is the first producer:
it publishes `design-doc.validation-requested` and a subscription starts the Playbook, replacing
the private start call once the subscription is proven. The other four events in D5 follow one at
a time.

### APIs

Under `/api/playbooks/triggers`, with `playbooks:triggers:manage` for changes and `playbooks:view`
for reads:

- list, create, update, pause, and delete subscriptions
- `POST /:triggerId/test` validates version, mapping, permissions, and admission, and creates no run
- `POST /:triggerId/run-now` writes a manual receipt and dispatches
- list receipts

The edit page gains a Triggers section. The form includes type, UTC schedule or event picker,
enabled, version policy, initiator, concurrency, mapping, dedupe preview, and Test. The receipt
list shows source, time, status, run link, attempts, error, next retry, and replay for dead letters.

Pause does not unpublish the Playbook.

### External wave

After internal triggers have real use:

- `POST /api/public/playbooks/triggers/:publicId`
- HMAC over the raw body, constant-time compare, unguessable public id
- project and subscription come from the verified identity, never from the body
- optional `playbooks:trigger` API-key scope
- request size and rate limits
- an Azure DevOps service-hook adapter that normalizes into the same receipt path

Clerk and PagerDuty are not in this wave. Add either as a later connector only when a named
workflow needs that event.

### Permission and flags

Add `playbooks:triggers:manage`, category `playbooks`, default role `admin`.

`playbooks-triggers` gates internal subscriptions, the scheduler, event dispatch, and the UI.
`playbooks-external-triggers` gates the public route and the Azure DevOps adapter. Both default
off.

Remove the internal flag after two stable sprints with acceptable duplicate, retry, and
dead-letter rates. Remove the external flag only after the security review of the internal path
and a non-production webhook pilot.

### Tests

- The same intent twice creates one run.
- Test mode creates no run.
- A disabled subscription does not dispatch.
- Competing schedulers create one run per occurrence.
- A dropped wake-up does not lose a due schedule, because the sweep is the guarantee.
- Permission and spend failures become receipts.
- Invalid webhook signatures reveal nothing about the subscription.
- Replayed Azure DevOps deliveries stay idempotent.
- Chained events cannot loop: a Playbook run cannot emit the event that started it unless the
  subscription's dedupe key collapses that pair.

## Chunk 3 — Actions, outbound connectors, and cloud agent

### `apex-action`

Register the type in the closed registry with schema version 1.

```ts
interface ApexActionStepConfig {
  operation: 'create-ado-items' | 'post-ado-comment' | 'set-document-status';
  parameters: Record<string, unknown>;
}
```

Each operation has its own Zod object, permissions, and side effect. Publish uses Part 1's binding
checks on `parameters`. The adapter calls the existing Azure DevOps or document service. It does
not call a model.

The drawer shows the operation name, the resolved parameters, and the service result summary.

### Connector interface

```ts
interface PlaybookConnector {
  id: string;
  displayName: string;
  secretRef?: string;
  inboundEvents: readonly string[];
  outboundOperations: readonly string[];
}
```

The first implementation wraps the Teams webhook already used by `notify`. `notify` stays a step
type. Its delivery goes through the Teams connector so later actions can send a message without a
second webhook client.

New inbound connector events join the trigger catalog. New outbound operations join `apex-action`
unless they need their own lifecycle.

### `cloud-agent` step

Extract the start, status, and cancel operations that My Work already uses so both callers share
them. The Playbook adapter:

- resolves work item id, repo, and prompt from bindings;
- calls the shared start function;
- suspends until the cloud-agent run reaches a terminal status, with a deadline;
- completes with the run id, status, and pull-request URL when one exists.

Eligibility failures complete the step as failed with the same reason My Work already returns.
The drawer embeds the existing activity stream.

This step counts as an agent step for the cap, is `leaves-apex`, and cannot be published without
a preceding approval gate.

### Flags

`playbooks-actions` gates `apex-action`, the Teams connector extraction, and the `cloud-agent`
step. Default off.

### Tests

- Each operation rejects a parameter object that fails its schema.
- A binding in `parameters` that fails Part 1 checks cannot publish.
- `create-ado-items` calls the existing service once for one step execution.
- The Teams path still completes when the webhook is unset.
- A cloud-agent step without a gate cannot publish.
- Two starts for the same work item still hit the existing live-run conflict.
- The Playbook path and My Work path share one Cursor client.

## Chunk 4 — Parallel, join, and bounded loop

### Design

Relax the guards only as follows:

- A node may have multiple outbound edges when it is marked as a parallel split. Every outbound
  edge starts. This is not a branch. A branch still chooses one of two arms.
- A `join` node may have multiple inbound edges. Config names the predecessor step ids and
  `policy: 'all' | { atLeast: number }`. Output is `{ arms: Record<stepId, output> }`.
- `foreach` config names a list binding and `maxIterations`. `until` config names a condition and
  `maxIterations`. Hitting the maximum fails the step with an error that names the cap.
- `findCycle` still rejects a back-edge.

The engine translator in `playbookEngine/runtime.ts` is the only Mastra change. If the pinned
Mastra version cannot express a parallel region or a join, upgrade through the Part 1 runbook
before writing the translator against a newer API.

Resume is per arm and per iteration. A suspended step in one arm does not mark the other arms
suspended. The run is suspended when any required arm is suspended and no arm is failed.

Agent-step and spend checks apply to every arm and every iteration, not to the join node alone.
A graph that can exceed the cap at its maximum iterations fails publish.

Bindings into a join use `steps.<joinId>.arms.<stepId>.<field>` and the Part 1 field check
understands that path. Bindings may not reach into an arm that the join does not wait for.

### Flag

`playbooks-parallel`, default off. Existing linear graphs stay valid with the flag off or on.

### Tests

- A back-edge still fails publish.
- Two arms run, a join waits, and a downstream binding reads one arm's field.
- One failed arm fails an `all` join and does not fail an `atLeast: 1` join when the other succeeded.
- `foreach` stops at `maxIterations`.
- A graph whose maximum iterations would exceed the agent cap fails publish.
- Restart mid-join resumes the unfinished arm and does not rerun a completed arm.
- Spend admission counts the worst case the graph can reach.

## Chunk 5 — Author assistance

### Recommender

A skill, run from the canvas, takes the author's goal and the current draft. It may only return:

- an existing step type from the registry, including `apex-action` and `cloud-agent` once those
  exist;
- a config that parses against that type's input schema;
- the bindings it intends to set, which must pass Part 1 checks against the draft;
- or a written gap when no type fits.

The author accepts the suggestion into the draft. Publish still runs every Part 1 and Part 2 guard.
The skill cannot call the registry's registration path, because there is not one.

Ship this after chunk 3 so the suggestion list includes actions. Shipping it against only the
original six types would teach authors to use `cursor-agent` for deterministic work.

### Tests

- The recommender's fixture output fails closed when it names an unknown step type.
- A suggested config that fails the input schema is not applied.

## Delivery order

### Wave 1 — Template catalog

Manifest, install, list and detail APIs, gallery, explicit apply-to-draft, interview template plus
Design Doc validation template, flag off.

Exit: two projects, two independent copies, published versions unchanged by a template update.

### Wave 2 — Internal triggers

Tables, permission, mapping, receipts, test and run-now, edit-page section, scheduler, first Apex
event, retry and dead letter.

Exit: duplicate delivery creates one run. Test creates none. Design Doc validation can start
through a subscription.

### Wave 3 — Remaining Apex events

Add the other four catalog events one at a time, each with a producer in the feature that already
owns that moment.

Exit: each event has one producer and a test that a subscription starts one run.

### Wave 4 — Actions and cloud agent

`apex-action` operations, Teams connector extraction, shared cloud-agent start function,
`cloud-agent` step, drawer renderer, flag off.

Exit: deterministic operations do not call a model. Cloud agent has one client. The step cannot
publish without a gate.

### Wave 5 — External triggers

Security review of waves 2 and 3, then HMAC webhook, API-key scope if needed, and Azure DevOps
adapter. Flag off until a non-production pilot.

Exit: signature, replay, and project-derivation tests pass.

### Wave 6 — Parallel, join, and bounded loop

Guard changes, translator, per-arm resume, cap accounting, flag off. Mastra pin upgrade first if
required.

Exit: the tests in chunk 4 pass, and a back-edge is still rejected.

### Wave 7 — Recommender

Canvas entry point, registry-constrained suggestions, accept into draft.

Exit: an unknown type cannot be applied.

## Testing strategy

Unit tests cover catalog version comparison, mapping, receipt idempotency, operation schemas,
join policies, iteration caps, and recommender output parsing.

Route tests cover every new permission and flag, template prerequisites, trigger test versus
run-now, and webhook signature and size limits.

Integration tests cover two-project install, subscription to run, competing schedulers, shared
cloud-agent start, and a parallel join resumed after restart.

Browser tests cover gallery install, trigger create and pause, action config, a parallel graph on
the canvas, and accepting a recommender suggestion. They run in CI.

## Security and privacy

- Trigger mappings cannot evaluate code.
- Webhook HMAC uses the raw body and a constant-time compare.
- Public routes derive the project from the verified identity.
- Receipts store only the payload needed for audit.
- Cloud-agent prompts stay in the existing private blob.
- `leaves-apex` steps, including `cloud-agent` and any external action, still require a gate.

## Reliability

- Template files that fail manifest validation fail the process that loads them.
- Receipt insert is the idempotency boundary.
- Scheduler and retry sweeps use advisory locks.
- Parallel arms complete or fail independently, and the join is the only place their results merge.
- A loop's maximum is enforced in the adapter, not only in the prompt.

## Observability

Record template browse, install, update offered, and update accepted. Record trigger dispatch,
duplicate, skip, start, retry, dead letter, and replay. Record action operation, success, and
failure by operation name. Record parallel arm duration and join policy. Record recommender
accept and reject. Do not log output bodies, webhook secrets, or full external payloads.

## Rollout

1. Enable the template catalog for the Apex project and install the two templates.
2. Enable internal triggers and move Design Doc validation onto a subscription.
3. Add the remaining Apex events.
4. Enable actions and the cloud-agent step for the Apex project.
5. Run the external-trigger security review, then one non-production webhook.
6. Enable parallel for one Playbook whose worst-case agent count is inside the cap.
7. Turn on the recommender for authors in the Apex project.

Each flag rolls back on its own. Installed templates remain if the catalog flag goes off.
Paused subscriptions remain if the trigger flag goes off, and they stop dispatching. Action and
parallel flags off refuse new publishes of those types and let in-flight runs finish.

## Migration

- Feature flags listed above.
- `playbooks:triggers:manage`.
- Trigger tables and nullable run-origin columns.
- No new table for templates, connectors, or actions.
- API-key scope `playbooks:trigger` only in the external wave.
- Update `.cursor/rules/rbac-governance.mdc` when the permission is added.

## Files

### New

- `src/server/playbookTemplates/catalog.json`
- `src/shared/types/playbookTemplates.ts`
- `src/shared/types/playbookTriggers.ts`
- `src/server/services/playbookTemplateCatalogService.ts`
- `src/server/services/playbookTriggerSubscriptionService.ts`
- `src/server/services/playbookTriggerDispatchService.ts`
- `src/server/services/playbookTriggerScheduler.ts`
- `src/server/services/playbookApexEventService.ts`
- `src/server/services/playbookSteps/apexActionAdapter.ts`
- `src/server/services/playbookSteps/cloudAgentAdapter.ts`
- `src/server/services/playbookConnectorRegistry.ts`
- `src/server/routes/playbookTriggers.ts`
- `src/client/components/PlaybookTemplateGallery.tsx`
- `src/client/components/PlaybookTriggersPanel.tsx`
- `src/client/hooks/usePlaybookTemplates.ts`
- `src/client/hooks/usePlaybookTriggers.ts`

### Existing, expected to change

- `src/server/services/playbookTemplateService.ts`
- `src/server/services/playbookSteps/registry.ts`
- `src/server/services/playbookSteps/index.ts`
- `src/server/services/playbookGuardService.ts`
- `src/server/services/playbookEngine/runtime.ts`
- `src/server/services/playbookBindingResolver.ts`
- `src/server/services/designDocValidationPlaybookService.ts`
- `src/server/services/cloudAgentService.ts`
- `src/server/services/playbookSteps/notifyAdapter.ts`
- `src/server/routes/playbooks.ts`
- `src/server/db/schema.ts`
- `src/shared/types/playbook.ts`
- `src/shared/types/apiKey.ts`
- `src/client/components/PlaybooksManagePage.tsx`
- `src/client/components/PlaybookEditPage.tsx`
- `src/client/components/PlaybookCanvas.tsx`
- `src/client/components/PlaybookStepDetailDrawer.tsx`
- `.cursor/rules/rbac-governance.mdc`
- `.cursor/CODEMAP.md`

The public webhook route mounts on the existing public API boundary. `src/server/index.ts` starts
the trigger scheduler and needs explicit approval when that wave is implemented.

## Work items

### Epic A — Templates

- TPL-001: catalog manifest and validation
- TPL-002: install and explicit apply-to-draft
- TPL-003: list and detail APIs with install state
- TPL-004: gallery
- TPL-005: update comparison and confirmation on the edit page
- TPL-006: Design Doc validation as the second template
- TPL-007: flag, audit, and tests

### Epic B — Internal triggers

- TRG-001: subscription, receipt, and run-origin schema
- TRG-002: permission and flags
- TRG-003: declarative mapping
- TRG-004: dispatcher and idempotency
- TRG-005: test, run-now, and receipt APIs
- TRG-006: edit-page Triggers section
- TRG-007: scheduler
- TRG-008: event catalog and Design Doc validation producer
- TRG-009: the other four Apex events
- TRG-010: retry, dead letter, pause, and replay

### Epic C — External triggers

- EXT-001: HMAC, rotation, and public route
- EXT-002: API-key scope if the pilot needs it
- EXT-003: Azure DevOps normalization
- EXT-004: replay, limits, and security tests

### Epic D — Actions and connectors

- ACT-001: `apex-action` descriptor, schemas, and adapter
- ACT-002: `create-ado-items`, `post-ado-comment`, `set-document-status`
- ACT-003: Teams connector extracted from `notify`
- ACT-004: shared cloud-agent start function
- ACT-005: `cloud-agent` step, gate rule, and drawer stream
- ACT-006: flag and tests

### Epic E — Parallel, join, and loop

- PAR-001: confirm the pinned Mastra version can express the region, or upgrade first
- PAR-002: parallel split guards and translator
- PAR-003: join policy and arm output map
- PAR-004: `foreach` and `until` with `maxIterations`
- PAR-005: per-arm resume and cap accounting
- PAR-006: flag and restart tests

### Epic F — Author assistance

- AST-001: recommender contract limited to the registry
- AST-002: canvas suggestion and accept path

## Acceptance criteria

1. Two shipped templates can be installed, edited, and explicitly updated, and published versions
   do not change when the template changes.
2. Schedule and Apex-event duplicates create one run, through `startRun`, as the configured user.
3. Design Doc validation starts from a subscription.
4. Signed webhook and Azure DevOps pilots pass replay and signature tests.
5. `apex-action` operations call existing Apex services and do not call a model.
6. The cloud-agent step uses the My Work service, stays behind a gate, and shows the existing
   activity stream in the Part 1 drawer.
7. Parallel arms join into an addressable output map, loops stop at their maximum, and a back-edge
   still cannot publish.
8. The recommender can only apply a registered step type.

## Open decisions

1. Is Design Doc validation the second template, or a smaller gate-agent-notify example?
2. How long are trigger payloads and dead-letter receipts kept?
3. Is the cost band on a template enough, or should it become a measured estimate later?
4. Should a later internal-trigger revision allow the event actor to be the initiator?
5. Which Azure DevOps events are in the first adapter?
6. Do external callers use HMAC, API keys, or both?
7. What is the default `maxIterations` for `foreach` and `until`?

Do not infer these during the wave that depends on them. Waves 1 through 4 can start without
decisions 5 through 7. Decision 1 is the only one that blocks a template choice, and the interview
template can ship either way. The SkillOpt skill and transcript decision moved to Part 3.
