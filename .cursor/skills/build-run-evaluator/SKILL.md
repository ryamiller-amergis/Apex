---
name: build-run-evaluator
description: Evaluates an Apex Build-from-prompt cloud agent run from intake through verification, including the build request, launch prompt, referenced skills, orchestration, generated changes, and full-stack Express template. Use when given a build run ID, cloud agent bc-* ID or URL, or playbook run ID and asked to improve build speed, reliability, context use, verification, or output quality.
disable-model-invocation: true
---

# Build Run Evaluator

Evaluate one completed or terminal Apex build run and recommend concrete orchestration improvements. Judge both implementation quality and the requester's experience. Base every finding on run evidence, repository evidence, or a clearly labeled inference. Do not change code, skills, prompts, settings, or infrastructure unless the user separately asks for implementation.

## Invocation

```text
/build-run-evaluator <build-run-id | cloud-agent-id-or-url | playbook-run-id>
```

An optional second identifier is a comparison run. Use it as a baseline only when the requests and repository states are similar.

## Required outcome

Produce:

1. a reconstruction of what Apex asked for and what the cloud agent received;
2. an evidence-based score using [rubric.md](rubric.md);
3. the main sources of user friction, delay, rework, excess context, or quality loss;
4. prioritized changes to Apex orchestration, skills, generated prompts, or the Express template;
5. a measurement plan that can prove whether each high-priority change helps.

Write both:

- `.ai-pilot/output/build-run-evaluations/{buildRunId}.md`
- `.ai-pilot/output/build-run-evaluations/{buildRunId}.json`

Create the output directory when needed. Never include credentials, personal data, full prompt blobs, full chat transcripts, or hidden reasoning in either report.

## Experience north star

Evaluate Apex against a deliberate blend of two builder experiences:

- **Base44-like prompt-to-app flow:** a non-technical person describes an outcome in plain language, sensible full-stack defaults are supplied automatically, a useful preview appears quickly, and the person can review, refine, restore, and publish without managing infrastructure.
- **Grok-like collaborative builder:** the app takes shape in the conversation, the agent acts autonomously, asks only high-value questions, uses strong repository tools and skills, shows meaningful progress, and supports fast follow-up changes without losing context.

These names are shorthand for outcomes, not a requirement to copy either product's interface. The Apex target is:

1. **Say it plainly:** the requester should not need to translate an idea into routes, schemas, components, test frameworks, or deployment steps.
2. **See value early:** acknowledge the request immediately, start autonomously after one confirmation, and minimize time to an interactive preview.
3. **Stay in the flow:** show short user-facing progress in product language while technical work stays in the background.
4. **Refine conversationally:** feedback such as “move this,” “add that,” or “make this easier” should preserve prior decisions and produce a new preview without restarting intake.
5. **Ship a complete app change:** frontend, backend, data, auth, tests, deployment, and rollback/version history should work as one managed path when applicable.
6. **Keep expert depth available:** plans, diffs, evidence, and code remain inspectable without forcing them on a non-technical requester.

Optimize for **requester effort**, **time to first useful preview**, **one-pass correctness**, and **ease of refinement**. Raw agent duration is secondary.

## Operating rules

- Use read-only access while evaluating. Do not retry, cancel, accept, merge, or relaunch the build.
- Treat the frozen launch snapshot as the run-time contract. A current skill file may have changed since the run.
- Distinguish `observed`, `derived`, `inferred`, and `unavailable` evidence.
- Missing data is `not scored`, not a failure. Report evidence coverage separately.
- Do not claim an efficiency gain from one run. Phrase it as an expected effect and define a follow-up measure.
- Do not reward a run merely for ending quickly. Quality and requirement coverage are gates.
- Prefer removing work, duplicate context, and avoidable retries before adding agents or parallelism.
- Do not recommend multi-agent execution unless the task graph has independent work, safe file ownership, and enough expected time savings to offset handoff and merge cost.
- Keep the original user outcome fixed. A recommendation that saves time by weakening scope, tests, accessibility, security, or evidence is invalid.
- Do not make the requester approve internal technical plans unless a material product, access, data, or integration decision truly belongs to them.

## Phase 1 — Resolve the run

Accept these identifiers:

- `bc-*` or a Cursor agent URL: match `agent_runs.cloud_agent_identity`.
- Agent run UUID: match `agent_runs.id`.
- Build run UUID: match `build_runs.id`.
- Playbook run UUID or Apex build URL: resolve through `build_runs.playbook_run_id` or the URL's build ID.

Resolve the identifiers in this order:

1. Use an authenticated Apex build API or UI when it exposes the needed record.
2. Use an available read-only database connection.
3. Use a user-supplied run export or artifact bundle.

If more than one build matches, ask the user to choose. If no build can be resolved, stop and state which identifier and data source were tried. Do not perform a repository-only review and present it as a run evaluation.

Record the resolved:

- build run, revision, task, agent run, cloud agent, interview, brief, and playbook IDs;
- repository, base commit, integration branch, task branch, and merge or validated commit;
- run status, start/end times, attempt count, repair count, caps, and terminal reason.

## Phase 2 — Collect the evidence bundle

Load only the data needed for the evaluation.

### Intent and intake

- `build_runs.prompt`
- approved `interview_briefs.sections`
- active `build_revisions.requirements`, risk decisions, assumptions, and exclusions
- intake messages and `build.intake.*` events when authorized
- unresolved items and sensitive-text warning events

Count intake questions and identify decisions that were either lost, invented, or repeated. Do not quote personal or sensitive text.

Record requester-effort signals:

- time to first acknowledgement;
- number of questions before confirmation;
- number of technical questions or choices exposed to the requester;
- time from confirmation to build start;
- user interventions required after confirmation;
- feedback rounds and whether each round preserved prior context;
- whether any follow-up revision (`revision >= 2`) re-entered `/build-intake` confirmation, rendered above the original build card, bypassed `fast_edit` due to screenshot attachments, or stalled in an unstarted `intake`/`planning` state.

### Execution contract

- `build_runs.skill_snapshot`
- `build_runs.quality_manifest_snapshot`
- current revision plan and validation
- every `build_tasks` row, including omitted legacy tasks
- every linked `agent_runs` row
- `agent_runs.build_launch_snapshot`
- prompt and context blob references and content hashes
- assembled prompt text when authorized
- cloud activity showing which skill or reference files the agent actually read, when available

Verify hashes where the source content is available. Report a mismatch as snapshot drift; do not assume the current checkout is what the run used.

### Timeline and outcome

- ordered `build_events`
- task and agent timestamps, statuses, attempts, and terminal reasons
- cost used versus cap and elapsed time versus cap
- `build_verification_rows`, evidence references, deferrals, and violation codes
- final-check, deployment, preview, acceptance, and pull-request outcomes
- task branch diff and commits when source-control access is available
- cloud-agent activity or result text when authorized
- user-visible status messages and timestamps
- first usable preview timestamp, preview failures, and time from feedback to refreshed preview

Token counts and tool-call logs are optional evidence. Mark them unavailable when Apex did not persist them; never estimate them from wall-clock time.

## Phase 3 — Reconstruct the actual path

Build a short ordered timeline from request through terminal outcome. Name the actual execution mode:

- `single-agent`: production `build-feature` task;
- `multi-task`: planner-generated task graph;
- `legacy-template`: target repository's native orchestrator;
- `mixed`: more than one path contributed.

Show two lanes in the report:

- **Requester lane:** prompt, questions, confirmation, visible progress, preview, feedback, acceptance.
- **System lane:** preflight, planning, dispatch, implementation, verification, merge, deployment.

Flag system stages that unnecessarily block the requester lane or expose internal details.

For current single-agent runs, trace:

1. intake and brief approval;
2. `startSingleAgentBuild`;
3. prompt assembly in `buildTaskExecutionPrompt`;
4. launch snapshot and cloud-agent dispatch;
5. evidence parsing and task completion;
6. merge, final check, deployment, preview, and acceptance.

Do not assume that every build skill in the repository ran. A skill counts as used only when the playbook profile, plan, task role, prompt, or launch snapshot references it.

Build a skill dependency list with these labels:

- `declared`: stored in the build profile or skill snapshot;
- `prompted`: named in the launch prompt;
- `observed`: cloud activity shows the agent read it;
- `transitive`: linked by a prompted or observed skill;
- `current-only`: present now but not proven to have affected the run.

## Phase 4 — Inspect instructions and template fit

Read the exact skill paths from the run snapshot first. Then inspect the current equivalents to identify potential updates:

- `.cursor/skills/build-intake/SKILL.md`
- `.cursor/skills/build-implementer/SKILL.md`
- role skills actually referenced by the run
- `.cursor/skills/build-final-check/standards-review.md`
- `src/server/playbookTemplates/build-from-prompt.json`
- `src/server/services/buildOrchestrator/singleAgentBuild.ts`
- `src/server/services/buildOrchestrator/taskCandidateBuilder.ts`
- `src/server/services/buildAgentLaunchService.ts`
- `src/server/services/buildOrchestrator/dispatchWiring.ts`
- `src/server/services/buildOrchestrator/applyCompletion.ts`
- `src/server/services/builds/verificationEvidenceChecker.ts`
- `src/server/services/build/finalCheck.ts`

For the target template, inspect:

- `templates/full-stack-express/AGENTS.md`
- `templates/full-stack-express/.cursor/CODEMAP.md`
- `templates/full-stack-express/.cursor/skills/build-implementer/SKILL.md`
- `templates/full-stack-express/.cursor/skills/product-quality/SKILL.md`
- `templates/full-stack-express/.cursor/skills/orchestrator/SKILL.md`
- template skills referenced by the implementer, especially API, UI, product-quality, design-system, testing, migration, QA, and integration guidance
- the quality manifest, environment file, package scripts, module map, component catalog, and reference feature slices

Check:

- request → brief → requirements → prompt → tests → output traceability;
- **two-part user-perspective verdict (Visual Craft & Component Quality vs. Product Fit for the Prompt)**:
  1. **Visual Craft & Component Quality (0–10)**: whether the rendered UI looks like a finished product — centered layout geometry (`AppShell` main container capped at `<= 960px` with `alignSelf: 'center'`), WCAG AA brand overrides in `overrides.ts`, clear hierarchy (`PageHeader`, `StatGrid`, `DataChartCard`, `NotificationCenter`, `ContentSurface`), and responsive light/dark styling;
  2. **Product Fit for the Prompt (0–10)**: whether the delivered app actually *is* the product the requester asked for, with zero unrequested industry/demo chrome leaking from the starter template:
     - **Domain & brand coherence**: the header, page title, KPI cards, charts, and copy all speak the requester's domain and project name (for example, an ATS or todo workspace), never a leftover starter brand or unrelated industry (such as "Northstar Ops", warehouse fulfillment batches, or dock alerts when the user asked for a todo list);
     - **Navigation hygiene**: primary navigation (`apps/web/src/app/App.tsx`) exposes only routes relevant to the requested application plus essential account frame (`Home` and `Profile`), never pre-mounted demo tabs (`Notifications`, `AI Insights`, `Settings`) that the requester did not ask for;
     - **Home-page ownership**: when the user asks to build a feature on the home page, the home route (`/`) is replaced by or centered around that feature rather than wedging the feature into the middle of pre-existing starter KPI cards and charts;
     - **Alive on first load**: the requested feature itself is seeded with 3–5 realistic domain records on first load (both in the database/API and preview store) so the user never lands on `Active: 0 / Total: 0` ("No matching items") while unrequested demo widgets show fake numbers;
- whether seeded data is tailored to the requested domain (never shipping `Item 1`, `Todo 1`, `project-name`, `My App`, or leftover starter industry copy);
- whether interactive journeys (charts with timeframe filters, notifications with unread counts and mark-as-read, and AI skill insights grounded in database + third-party connector feeds, when requested) work end-to-end;
- whether the requester could remain in plain product language from request through refinement;
- whether Apex chose sensible full-stack defaults instead of asking for technical implementation choices;
- whether the UI distinguished “build now” from “discuss first” intent without adding ceremony;
- whether progress messages explained visible outcomes rather than internal task mechanics;
- whether an interactive preview appeared as early as safely possible and remained easy to revisit;
- **Conversational Revision & Fast-Edit UX Contract (`revision >= 2`)**:
  - **Zero-confirmation revisions**: once the original build reaches preview, follow-up revision requests (including requests with pasted screenshots) never re-enter `/build-intake` or ask `"Does this match what you want? a. Confirm b. Change it"` — they transition immediately to active execution (`building`);
  - **Chronological thread ordering**: only `Revision 1` intake turns appear above `"The original build finished. Each change you asked for is shown below."`; all `Revision 2+` requests and their output appear chronologically below the original build card inside `BuildRevisionSections`, never duplicated above the original build card;
  - **Fast-edit studio execution for visual updates**: visual, layout, sizing, alignment, spacing, copy, and component updates (with or without screenshots) execute through `buildRevisionFastEditService` (`classify` → `edit` → `apply` → `checking` → `ready`) against the warm Studio preview rather than stalling in `intake`/`planning` or running a full cloud build;
  - **Live step-by-step revision output**: the active `Revision N` card displays concrete stage headlines (`"Applying your visual update to the preview…"`, `"Preview updated — running quick checks…"`, `"The preview was updated with this change."`) and opens its live updates drawer while running so the user sees output happen in real time;
- whether version history, rollback, and prior decisions made experimentation safe;
- whether acceptance, publishing, pull-request creation, and sharing felt like one coherent finish;
- duplicated or conflicting instructions across the generated prompt, implementer skill, repository rules, and template docs;
- drift between the Apex skill, template copy, and frozen run-time version;
- context loaded unconditionally that could be selected by task domain;
- required context omitted from the prompt or unavailable to the agent;
- skill routing based on the actual change surface;
- template friction that caused searching, reinvention, command failures, or off-pattern code;
- repeated setup, install, type-check, lint, test, or visual-review work;
- retries caused by weak preflight, unclear contracts, evidence formatting, or infrastructure;
- whether verification measured user behavior instead of only implementation details;
- whether the agent reused existing components, contracts, and feature slices;
- whether the final evidence accurately reflects commands and commits.

## Phase 5 — Score

Read [rubric.md](rubric.md). Score only dimensions with enough evidence. Include:

- weighted score;
- evidence coverage percentage;
- confidence (`low`, `medium`, or `high`);
- quality-gate cap, if one applies;
- verdict.

For every deduction, cite a record ID, event ordinal, artifact hash/reference, commit/path, or skill section. Do not cite raw secrets or personal text.

## Phase 6 — Diagnose waste and quality loss

Classify each finding with one category:

- `requester-friction`
- `slow-first-value`
- `opaque-progress`
- `preview-friction`
- `revision-friction`
- `intent-loss`
- `prompt-duplication`
- `unnecessary-context`
- `missing-context`
- `wrong-skill-routing`
- `template-friction`
- `avoidable-retry`
- `serial-bottleneck`
- `weak-verification`
- `observability-gap`
- `stale-contract`
- `overconstraint`
- `underconstraint`
- `output-regression`

Separate symptoms from causes. For example, a second agent attempt is a symptom; a quality command omitted from preflight may be the cause.

Quantify observed waste where possible:

- requester turns and avoidable questions;
- time to confirmation, build start, first preview, and refreshed preview;
- user-visible idle periods with no useful status;
- time in each stage;
- duplicate prompt lines or repeated instruction blocks;
- repeated command runs;
- failed attempts and repair loops;
- requirements without valid evidence;
- unused skills or context supplied to the agent;
- changed files that conflict with reuse candidates or template patterns.

## Phase 7 — Recommend changes

Each recommendation must contain:

- stable ID (`REC-1`, `REC-2`, ...);
- category and priority (`now`, `next`, `experiment`, or `defer`);
- exact target files or orchestration stage;
- concrete change;
- evidence and root cause;
- expected effect;
- implementation effort (`small`, `medium`, or `large`);
- regression risk (`low`, `medium`, or `high`);
- confidence;
- validation metric and guardrail.

Prioritize recommendations in this order:

1. prevent incorrect or incomplete output;
2. reduce requester effort and time to first useful preview;
3. make conversational refinement preserve context and produce quick incremental previews;
4. remove avoidable retries and launch failures;
5. remove duplicated instructions and unconditional context;
6. improve template discoverability and reusable full-stack patterns;
7. improve routing, concurrency, or model choice;
8. add missing measurements.

Include at least one recommendation for instrumentation when evidence coverage is below 80%. Suggested signals include requester turns, intake questions, technical questions, time to confirmation, time to build start, time to first and refreshed preview, prompt size/hash, referenced-skill hashes, stage durations, command attempts, tool-call counts, token totals, and a durable redacted result summary.

Also include:

- **Keep:** behavior that worked and should not change.
- **Do not optimize:** tempting changes that would reduce quality or add handoff cost.
- **Experiments:** changes needing comparison across at least five similar runs.

## Report shape

The Markdown report must contain:

1. Executive summary
2. North-star builder experience assessment
3. Run identity and evidence coverage
4. Requester and system timelines
5. Request-to-output trace
6. Measured signals
7. Scorecard
8. Findings
9. Prioritized recommendations
10. Keep / do not optimize
11. Experiment and measurement plan
12. Unavailable evidence and limitations

The JSON report must use this top-level shape:

```json
{
  "schemaVersion": 1,
  "buildRunId": "uuid",
  "agentRunIds": ["uuid"],
  "cloudAgentIds": ["bc-*"],
  "executionMode": "single-agent | multi-task | legacy-template | mixed",
  "status": "string",
  "experienceBenchmark": "base44-grok-blend",
  "evidenceCoveragePct": 0,
  "confidence": "low | medium | high",
  "score": {
    "raw": null,
    "capped": null,
    "verdict": "efficient | targeted-tuning | material-waste | redesign-needed | not-scorable",
    "userPerspective": {
      "visualCraftScoreOutOf10": null,
      "productFitScoreOutOf10": null,
      "unrequestedTemplateScopeLeaked": false,
      "requestedFeatureSeededOnFirstLoad": null,
      "summary": "string"
    },
    "dimensions": []
  },
  "measurements": {
    "requesterTurns": null,
    "intakeQuestions": null,
    "technicalQuestions": null,
    "timeToConfirmationSeconds": null,
    "timeToBuildStartSeconds": null,
    "timeToFirstPreviewSeconds": null,
    "timeToRefreshedPreviewSeconds": null,
    "postConfirmationInterventions": null
  },
  "findings": [],
  "recommendations": [],
  "keep": [],
  "doNotOptimize": [],
  "experiments": [],
  "limitations": []
}
```

Use valid JSON with no comments or trailing commas.

## Completion

Return a concise summary with:

- verdict, score, and evidence coverage;
- the three highest-value recommendations;
- paths to both reports.

If the run is still active, label the result `interim`, omit outcome scoring, and identify which terminal evidence is pending.
