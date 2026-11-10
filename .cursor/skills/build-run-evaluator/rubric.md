# Build Run Evaluation Rubric

Score the run, not the current repository. Use the frozen launch snapshot and base commit whenever possible.

## Scoring method

Score each applicable check:

- `3` — strong: complete, direct evidence, no material waste or defect.
- `2` — acceptable: outcome is correct with minor friction.
- `1` — weak: material ambiguity, waste, rework, or incomplete evidence.
- `0` — broken: missing required behavior, conflict, failed gate, or avoidable failure.
- `NA` — unavailable or not applicable. Explain why.

For each dimension:

```text
dimensionPct = sum(check scores) / (3 * applicable check count) * 100
```

Overall:

```text
rawScore = sum(dimensionPct * dimensionWeight) / sum(scored dimension weights)
```

Round to the nearest whole number. Do not score a dimension with fewer than two applicable checks.

Evidence coverage:

```text
evidenceCoveragePct = observed required evidence items / required evidence items * 100
```

Required evidence items are: original request, approved brief, active requirements and risks, task records, agent attempt records, launch snapshot, referenced skill contents or hashes, ordered events, verification rows, and terminal outcome. Prompt text, cloud activity, source diff, and token/tool-call metrics improve confidence but are not required to score.

If evidence coverage is below 50%, use verdict `not-scorable` and provide findings and recommendations without an overall score.

## Dimensions

### 1. Intent fidelity and conversational intake — 15%

Score:

1. The approved brief preserves the user's outcome and makes material assumptions explicit.
2. Requirements, exclusions, and risk decisions cover the approved brief without adding unrelated scope.
3. The launch prompt carries every active requirement and material constraint.
4. The delivered change and tests match the requested user outcome.
5. The requester stays in plain product language and answers only questions that materially change access, data, integration, workflow, or visible behavior.

Deduct for repeated questions, technical implementation choices pushed to the requester, unresolved material items sent to implementation, lost exclusions, invented requirements, or output that satisfies test wording but misses the user workflow.

### 2. Prompt-to-preview builder experience — 20%

Score:

1. Apex acknowledges the request immediately, reaches confirmation with minimal effort, and starts the build without avoidable ceremony.
2. User-visible progress is timely, concise, and expressed as product outcomes rather than internal agent or repository mechanics.
3. A useful interactive preview appears as early as safely possible, with a clear path to inspect, share, accept, or publish it.
4. Follow-up feedback preserves earlier decisions and produces an incremental preview without restarting intake or requiring the request to be restated.
5. Non-technical users can complete the flow without handling infrastructure, code, branches, models, test commands, or deployment details; experts can inspect those details when wanted.

Deduct for silent waits, technical jargon, repeated confirmation, preview appearing only after all internal work could have been staged earlier, lost context between revisions, or separate build/deploy/share steps that feel disconnected.

Use requester turns, question count, time to confirmation, time to build start, time to first preview, post-confirmation interventions, feedback-to-preview time, and preview availability. Mark unavailable metrics explicitly.

### 3. Instruction and context efficiency — 15%

Score:

1. The intended model and skill were selected, frozen, and readable at launch.
2. The generated prompt and loaded skill have no material conflicts or repeated instruction blocks.
3. Domain context is selected by change surface; unrelated skills and documents are not loaded unconditionally.
4. Quality commands, standards hashes, branch details, and ownership constraints are clear and usable.

Deduct for duplicated runtime/setup instructions, repeated full contracts, ambiguous ownership, stale hashes, missing referenced files, contradictory escalation rules, or broad context that does not affect the task.

### 4. Execution efficiency — 15%

Score:

1. Queue, intake, planning, building, checking, and deployment time contain no unexplained or avoidable delay.
2. The run completes with no avoidable relaunch, repair loop, lost launch, timeout, or repeated setup.
3. Commands and tests are scoped sensibly, failures are repaired once, and unchanged expensive gates are not rerun without cause.
4. Execution topology fits the work: one agent for tightly coupled work; parallel tasks only for independent work with safe ownership.

Use stage durations, attempts, repair count, task events, terminal reasons, command history, and cap use. Do not infer token efficiency from duration.

### 5. Verification and outcome quality — 20%

Score:

1. Every active `AC-*`, `DOD-*`, `BR-*`, `NFR-*`, and `RD-*` has valid traceability or an allowed deferral.
2. Red/green commits and named tests are genuine, commands match evidence, and required checks pass.
3. UI work includes useful visual and accessibility evidence; non-UI work is not burdened with irrelevant visual work.
4. End-user visual polish, tailored domain data (never `Item 1` / `Todo 1` / `project-name`), centered layout geometry (`AppShell` `maxWidth <= 960` and `alignSelf: 'center'`), and working interactive journeys (charts, notifications, grounded AI insights) are verified.
5. The final diff is coherent, preserves existing behavior, and reaches the expected final-check, deployment, preview, or acceptance state.

Deduct for implementation-detail-only tests, evidence assembled after the fact, identical red/green commits, skipped gates, weak deferrals, generic placeholder sample data, uncentered layout geometry, broken interactive journeys, unrelated changes, or a passing evidence block that conflicts with actual records.

### 6. Template fit and managed full-stack defaults — 10%

Score:

1. The agent searches the code map, module map, component catalog, and relevant reference slice before creating modules.
2. API, UI, migration, design-system, and testing skills are loaded only when their domains apply.
3. The agent uses the template's package manager, scripts, contracts, components, error format, and migration conventions.
4. Template documentation and examples let the agent find the correct pattern without avoidable searching or reinvention.
5. Common app needs—responsive UI, data, identity, errors, loading states, testing, deployment, and rollback—have safe defaults that do not require the requester to specify plumbing.

Deduct when template drift, missing examples, stale paths, duplicate orchestration guidance, or poor discoverability causes off-pattern code, command failures, or user questions about routine full-stack concerns.

### 7. Observability and learnability — 5%

Score:

1. IDs, attempts, statuses, and ordered stage timestamps reconstruct the run.
2. The frozen launch snapshot, prompt hash, skill hashes, and quality manifest are durable and retrievable.
3. Prompt size, command attempts, tool calls, tokens, and cost are measured at useful granularity.
4. Evidence distinguishes user-request defects, prompt defects, agent execution defects, template friction, and infrastructure failures.

Unlike other dimensions, absent telemetry is a real deduction here, not `NA`.

## Quality gates and caps

Apply the first matching cap after calculating the raw score:

- Cap at `49` when a terminal run has a failed or pending active acceptance criterion, business rule, definition-of-done item, or risk decision.
- Cap at `49` when the delivered change materially misses the approved user outcome.
- Cap at `74` when a user-facing UI or mixed build reaches terminal success without a usable preview.
- Cap at `74` when required quality commands, source diff, or final-check result cannot be verified.
- Cap at `89` when the run succeeded only after an avoidable relaunch or repair attempt.

Do not cap:

- an active run; report it as `interim` and omit outcome scoring;
- a user-cancelled run before implementation; mark it `not-scorable`;
- an allowed E2E or NFR deferral with a committed test reference and specific reason.

## Verdicts

- `efficient`: capped score 90–100.
- `targeted-tuning`: capped score 75–89.
- `material-waste`: capped score 50–74.
- `redesign-needed`: capped score 0–49.
- `not-scorable`: evidence coverage below 50% or no meaningful execution occurred.

## Finding severity

- `critical` — security, privacy, destructive data behavior, or a false successful outcome.
- `high` — causes a failed run, missing user outcome, relaunch, or invalid required evidence.
- `medium` — measurable delay, repeated work, excess context, or template friction.
- `low` — limited cleanup or instrumentation improvement.

## Recommendation priority

- `now` — high-confidence fix for a critical/high finding or repeated avoidable cost.
- `next` — medium-confidence improvement with a clear metric and low-to-medium regression risk.
- `experiment` — plausible change that needs comparable-run evidence, especially model, context, concurrency, or topology changes.
- `defer` — low impact, high risk, or blocked by missing evidence.

Never state a numeric speed or cost improvement unless calculated from comparable observed runs. For a single run, use directional language and define the metric that will test it.
