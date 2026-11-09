# Skill Learning (formerly Skill Health + workflow human evaluation)
Updated: 2026-11-09. Repo: Apex. Branch: feature/skill-health-v0 (main merged at d87836fa)

## Goal
A closed improvement loop for every AI skill in Apex: observe -> evaluate -> attribute -> curate -> change -> validate -> promote -> monitor.
Done means: each covered surface records provenance and feedback; the judge is blind and calibrated against humans;
a candidate SKILL.md is replayed against versioned cases, wins on held-out cases with no critical regression,
and reaches a pull request only after a person approves it in a Playbook gate. North-star metric:
AI cost + reviewer minutes per accepted artifact, per skill version.

## Constraints & decisions
- One flag for everything: rename `workflow-human-evaluation` -> `skill-learning` (user, 2026-11-09). Rename by UPDATE of feature_flags.key so rules (by flag_id) survive.
- New surfaces: optional ratings + implicit signals only. No new approval blocks (user).
- Better skill -> replay proof -> Playbook approval gate -> pull request (user). Never auto-apply.
- Replay/optimizer spend: per-project monthly budget in Platform Admin, off until set (user).
- New surfaces: ADR, ADR assistant, brainstorm, Playbook steps, Build intake, QA Lab, PRD assistant, design doc assistant (user).
- Adding a surface must be a registry entry, not a CHECK-constraint migration (avoid the per-subject-type migrations used so far).
- Workers hold no policy: App Service resolves model/effort/skill/budget and the spec carries it (.cursor/rules/v2-worker-no-policy.mdc).
- Large evaluation inputs go through Blob like main's documentInputSnapshot, not inline on the spec.
- Judge trust bands (industry standard): weighted kappa >= 0.6 may gate; 0.4-0.6 advisory; < 0.4 not trusted.

## Phases
0. Flag rename to `skill-learning` (migration + constant + @feature-flag markers + seed tests).
1. Measurement integrity
   a. Blind judge: drop `humanScoreHints` from the judge package and instructions.
   b. Judge-human agreement per stage and criterion (quadratic weighted kappa) + trust band in Skill Health.
   c. Provenance table `skill_run_provenance` (surface, subject, skill path, sha256, model, effort, run id) for every surface.
   d. Efficiency metrics: regenerations per accepted, review rounds, time to approval, failed runs, cost per accepted.
   e. Confidence intervals (Wilson for rates, bootstrap for means) and a minimum sample before comparing versions.
2. Signal layer for new surfaces
   a. Append-only `skill_signals` + surface registry in src/shared/constants/skillLearningSurfaces.ts.
   b. Emitters at existing decision points: QA Lab proposals accept/reject + regenerations; brainstorm handoff completed/failed + rollbacks;
      Playbook gate approve/reject + step failed; ADR finalize/regenerate; assistants' suggestion applied/dismissed; build intake completed/abandoned.
   c. Optional rating control on each surface (reuse ChatMessageRating).
   d. Sampled artifact judge for artifact surfaces (ADR, brainstorm artifact, build brief, QA case set) with rubrics in the registry.
3. Closed loop
   a. Versioned eval datasets (regression cases + implicit failures + successful controls + canaries), dev/holdout split.
   b. Replay workflow on the document worker: baseline vs candidate SKILL.md on the same cases, blind judge + Promptfoo, paired comparison.
   c. Reflective candidate generation (GEPA-style: read failures + judge rationale, propose smallest SKILL.md edit, keep Pareto set).
   d. "Skill improvement" Playbook template: replay -> approval gate -> PR. Promotion record: versions, dataset, evaluator versions, scores, approver, rollback ref.
   e. Post-release monitoring: live before/after per version; flag regressions.
   f. Budget enforcement + spend labelled `skill-learning` in AI cost analytics.
4. Judge maintenance: drift alerts, recalibration from human disagreements, ask humans only where the judge is unsure (active learning).
5. Promptfoo beyond structure: assertions mined from corrected text; llm-rubric checks for calibrated failure modes; eval-coverage metric.
6. UI: Skill Health -> Skill Learning hub (Overview, Coverage, Skill detail, Judge calibration, Datasets, Experiments, Proposals, Budget).

## Closed-loop design (Phase 3) — decided 11:50
- Replay = the original V2 run's frozen spec (agent_runs.execution_snapshot: prompt, scratchInputs, model, effort,
  groundedSha) with skillContent/skillSha256 swapped. Inputs, model and code stay identical; only the Skill changes.
- Both arms rerun on every case: baseline = SKILL.md frozen in the project's newest V2 run for that skill path;
  candidate = proposed text. Paired design, same case, same inputs.
- Worker untouched: replays use existing classes `prd` / `design-doc` (generation) and `evaluation-judge` (scoring) on
  replay-owned thread ids. documentV2Harvest asks `skillReplay.owns(...)` first and routes output to the experiment.
- Cases: active regression cases with snapshot (failures) + recent high-scoring evaluation events (controls, guard
  against regressions). Deterministic split by sha256(caseKey): 80% dev, 20% holdout. Holdout never shown to the
  candidate generator.
- Scope v1: subject types prd and design_doc (V2 generation runs). Interview phases are conversational — not replayable.
- Decision rule: recommend promote only if dev mean paired diff > 0 with 95% t interval low > 0, holdout diff >= -0.25,
  no criterion mean drop > 0.5, failure rate not higher. Otherwise "keep current".
- Candidate generation (GEPA-style reflective): App Service Bedrock call reads baseline SKILL.md + dev failures
  (judge rationale, reviewer comments, corrected text) and returns the smallest edited SKILL.md + change notes.
- Promotion: experiment -> "awaiting approval" Playbook gate -> on approve, open a PR editing only that SKILL.md in the
  project's skill repo (refuse if repo file sha != baseline sha). Promotion record keeps versions, dataset, scores,
  approver, PR url, rollback sha.
- Budget: per-project monthly USD in `skill_learning_settings`; null = off (no experiments). Estimate before start,
  refuse if over; spend recorded with entity type `skill_experiment`.

## Key files
- src/shared/types/workflowEvaluation.ts: subject types, stages, criteria
- src/server/services/workflowEvaluationSpecificationBuilder.ts:470-510: judge spec (humanScoreHints here)
- src/server/services/workflowEvaluationJudgeInstructions.ts:36: hint instruction
- src/server/services/workflowEvaluationSuites.ts: Promptfoo suites (structural only)
- src/server/services/skillHealthService.ts, skillHealthMetrics.ts, skillHealthEvaluationMetrics.ts
- src/server/services/skillRegressionCaseService.ts: regression capture
- src/shared/constants/projectSkillWorkflows.ts: registry pattern to copy
- Implicit signal sources: qa_lab_assistant_proposals, qa_case_regenerations, brainstorm_actions, brainstorm_artifact_versions (rollback), playbook_step_runs / playbook gates, adrs, build_runs
- migrations/20261016161100_seed-workflow-human-evaluation-flag.sql: flag seed

## Done
- [x] Merge main into branch; judge settings moved to project_skill_workflow_settings (d87836fa)
- [x] Phase 0: flag renamed to `skill-learning` (migration 20261109162112_4caf, SKILL_LEARNING_FLAG). Uncommitted.
- [x] Phase 1a: blind judge + per-criterion judge scores (definition v2, migration 20261109162237_7102).
- [x] Phase 1b: judge-human kappa + trust band (skillLearningStats.ts, buildJudgeAgreement, panel line).
- [x] Phase 2a: skill_signals table (migration 20261109162752_e2e4), surface registry, skillSignalService
      (recordSkillSignal / emitSkillSignal / emitSkillSignalLater — the Later form catches lookup throws).
- [x] Phase 2b emitters wired:
      QA Lab proposal applied/discarded (qaLabAssistantProposalService.decide), case regenerate + restore (qaCaseRegenerationService);
      ADR assistant apply (editedBeforeApply) / reject, ADR generation completed / run_failed (adrService);
      PRD assistant apply (prdService.applyProposedPrdChanges), reject + regenerate section (routes/interviews.ts);
      Design doc assistant apply / selective apply / regenerate section / reject (routes/interviews.ts helper);
      Playbook gate decisions (playbookGateService.decideGate), step failures (playbookSteps/stepRuns.failStepRun);
      Brainstorm handoff completed/failed (brainstormHandoffEngine persistence), artifact rollback (brainstormArtifactVersionStore);
      Build intake brief approved (buildBriefService.approveBuildBrief, editedBeforeApprove = version > 1).
- [x] Signal aggregation: skillSignalMetrics.ts (acceptance + Wilson, edited-before-accept, regenerations per accept,
      failure rate, rating score, per-version split with MIN_VERSION_SAMPLE) -> SkillHealthProject.signals;
      SkillHealthSignalsPanel.tsx in SkillHealthAdmin. Tests: skillSignalMetrics, skillSignalService, SkillHealthAdmin.
- Verified: both tsc clean; affected suites pass (16 server suites, SkillHealthAdmin client suite); codemap OK.
- [x] (A) Phase 3 closed loop, uncommitted, not yet run against a real database or worker:
      - migration 20261109165205_e11f_skill-experiments.sql (skill_learning_settings, skill_experiments, skill_experiment_runs) + schema.ts tables
      - shared/types/skillExperiment.ts; skillExperimentStats.ts (paired t interval, 20% holdout, decision rule)
      - skillReplaySpec.ts (swap SKILL.md in the frozen V2 spec; thread ids skill-replay:<runId>:generate|judge)
      - skillCandidateGenerator.ts (Bedrock reflective draft, size limits); 'skill-learning' AiFeature
      - skillExperimentService.ts (budget, cases, dispatch, judge, finish, approval Playbook, sweep, listReplayableSkills)
      - skillPromotionService.ts (PR on GitHub/ADO; refuses if SKILL.md changed upstream; keeps line endings)
      - documentV2Harvest.ts routes replay threads to the experiment (skillReplays dependency)
      - routes/skillExperiments.ts under /api/platform-admin/skill-health/experiments (settings, skills, list, start, get, cancel, retry-promotion);
        2-minute sweep registered at module load (skipped in tests). Approval is read by the sweep, not by a Playbook event.
      - client: hooks/useSkillExperiments.ts, SkillExperimentsPanel.tsx (+ .module.css) in SkillHealthAdmin, gated by flag skill-learning
      - tests: skillReplaySpec, skillCandidateGenerator, skillPromotionService, documentV2Harvest (+2), SkillExperimentsPanel; all pass; both tsc clean; testid + codemap OK
      - Still open in (A): Blob for large judge inputs, Promptfoo semantic checks, human-only holdout set, skillExperimentService unit tests with a mocked db.

- [x] (B) Measurement (12:30): reviewDecisionSignals.ts (every approver/owner decision -> accepted/rejected signal, hooked in
      documentApprovalService.recordApproverResponse + ownerApprovalService.recordOwnerApproval); SkillHealthSkill.models
      (model+effort breakdown) and .efficiency (median hours to approval, review rounds, assistant retries, cost per accepted);
      versions carry scoreInterval, passRateInterval, sufficientSample. UI in SkillHealthAdmin SkillDetail.
- [x] (C) Ratings: shared/types/skillRating.ts, skillRatingService.ts (delete+insert in a tx because skill_signals blocks UPDATE),
      GET/PUT /api/projects/:projectId/workflow-evaluations/skill-ratings, hooks/useSkillRatings.ts, SkillRating.tsx.
      Placed on: ChatAgentPanel assistant replies (prd/design-doc/adr), BrainstormArtifactPanel, QaLabAssistantPanel (latest reply),
      PlaybookRunList (finished runs), BuildBriefReview, AdrChatView.
- [x] Build intake abandoned: buildIntakeAbandonSweep.ts (14 days idle, draft or no brief), hourly interval in routes/skillExperiments.ts.
- [x] Post-release: skillPostRelease.ts (live docs by baseline sha vs candidate LF/CRLF sha; waiting/collecting/holding/regressed;
      hourly sweep notifies owner once on regressed). SkillExperimentDetail.postRelease, PostReleaseView in panel.
- [x] Pareto set: skillCandidateFrontier.ts (non-dominated on dev change, each criterion, failure rate; same baseline sha; top 5).
      GET /experiments/frontier; "Start from this" in the start form; drafter prompt gets prior attempts.
      Blob for judge inputs SKIPPED: packages already capped at WORKFLOW_EVALUATION_PACKAGE_MAX_BYTES; moving needs worker+infra change (ask user).
- [x] Judge upkeep: SkillHealthJudgeAgreement.drift (30-day window vs before, >=10 reviews each, kappa drop >=0.15) and
      .recheck (gap >=2 or judge confidence low, top 10). Shown in SkillHealthEvaluationPanel. No notification (Skill Health is on-demand).
- [x] Sampled artifact judge: skillArtifactJudge.ts (ADR, brainstorm artifact, build brief v1 revision, QA case set md; ~20% md5 sample;
      Bedrock rubric 1–5; 'judged' signal with scores+costUsd in metadata). Migration 20261109181100_210c adds 'judged' kind.
      Judge spend counts in the Skill Learning budget (committedThisMonth). Hourly sweep; needs budget >= full-sweep cost.
      Outcomes table shows "Sampled judge (1–5)".
- [x] Mined Promptfoo checks: skillMinedChecks.ts (## headings in >=60% and >=3 corrected texts, not already in the suite),
      table skill_mined_checks (migration 20261109181100_e6cf) stores accept/dismiss; accepted ones appended to the suite in
      workflowEvaluationSpecificationBuilder (dependency loadMinedTests). GET/PUT /experiments/mined-checks. SkillMinedChecksPanel.
      Now reads corrections from Blob (see next item).
- [x] Corrections read from Blob (user chose "compare original vs corrected"): skillCorrections.ts loads
      corrected-artifact.md (correctedArtifactBlobRef, legacy inline text as fallback) and original-artifact.json
      (skill_regression_cases.original_blob_ref when snapshot_status='stored'); diffCorrection/formatCorrectionDiff.
      Miner counts only headings the reviewer ADDED (all headings when no original); 60 events/stage, 10-min cache.
      Drafter evidence gets correctionChanges (+/- lines, sections added/removed); full corrected excerpt only without original.
      Readers in workflowEvaluationArtifactStore (readCorrectedArtifact, readRegressionSnapshot, snapshotText).
      Tests: skillCorrections.test.ts, skillMinedChecks.test.ts. Server tsc + eslint clean.
- [x] Hub tabs: SkillHealthAdmin tabs Skills / Human feedback / Outcomes / Learning (testids skill-health-tab-*).
- [x] Wrap-up (z1): skillExperimentService.test.ts; approval graph moved to skillApprovalPlaybook.ts (allow-listed in
      playbookStepRegistry.test.ts like designDocValidationPlaybookService); CHANGELOG 1.42.0 retitled "Skill Health and
      Skill Learning" with 8 new entries (1.42.0 is not on main, so no new sync migration); AGENTS.md Skill Learning row.
      Both tsc clean, eslint clean on changed files, testid + codemap checks pass.
      Full suite: 998/1004 suites pass. Failing, not touched by this work (timeouts): repoCacheGitIntegration, repoReader,
      groundedRepositoryCheckout, groundingBundleStoreService (passes alone), featureRequestAnalysisService (times out alone too).

## State: stages 1-3 code complete, ready for user testing. Nothing committed or pushed.
Full suite: 1003/1009 suites pass; the 6 failures are git/repo timeouts under load (mcpRepoReaderDelegation passes alone).
To test: run migrations; turn on flag skill-learning for a project; Skill Health -> Learning tab -> set a monthly budget.

## Next — "keep AI work on the V2 worker" (user, 13:45)
User rule: App Service must not run AI calls; V2 infra exists to take load off App Service.
Decisions: AI-graded checks = real Promptfoo llm-rubric in the worker; mining = new worker run type; move
skillCandidateGenerator + skillArtifactJudge (Bedrock on App Service today) to the worker in this change;
model access = Bedrock creds for the document worker via Terraform (infra/ai-platform-v2-runtime.tf, like visual);
"Suggest checks" only on button click; deliver in stages, testing each.
Holdout: already human-only (failure = regression cases from reviews, control = high human scores). Nothing to do.
Design:
- Promptfoo child stays sealed (no creds, blocked proxy). llm-rubric grader = custom provider that forwards each
  grading prompt over IPC to the worker parent, which calls Bedrock. Grader model id comes in the spec (no worker default).
- New document workflow classes run cursor-agent like evaluation-judge: App Service builds scratch inputs + skill
  text, harvest routes the output back (like skillReplay.owns).
Stages:
1. [x] DONE (awaiting user test). One generic worker class `skill-learning` (not one per task):
       - shared/types/aiRunV2DocumentSpec.ts: class + SKILL_LEARNING_SCRATCH_PATHS (input.json, output-schema.json),
         SKILL_LEARNING_RESULT_FILE, documentWorkflowResultFile(); outputSchema required (closed object), no repo fields.
       - worker documentExecution.ts: expects exactly skill-learning-result.json and checks it against outputSchema
         (assertResultMatchesSchema, shared with the judge). finishedAttemptReader SQL lists include the class.
       - skillLearningRuns.ts: thread ids `skill-learning:<task>:<subjectKey>`, spec builder (model from
         resolveEvaluationJudgeModel on App Service), admitSkillLearningRun (context kept on execution_snapshot).
       - skillLearningHarvest.ts: routes completed/failed runs; documentV2Harvest's SkillReplayHarvest now also owns
         these threads and passes runId.
       - Rewriter: skillCandidateGenerator.ts = frozen CANDIDATE_INSTRUCTIONS@1 + buildCandidateInput + parseCandidateResult.
         Experiment status 'drafting' (migration 20261109185105_b9bb: candidate nullable, draft_run_id, error,
         candidate_check). applyCandidateDrafted -> 'running'; failures/timeouts -> 'failed' with error. UI shows it.
       - Sampled judge: hourly sweep admits runs (skips artifacts with any prior run on the thread); harvest records
         the judged signal. Spend = started judge runs x estimate (judgedSpendSince counts agent_runs).
       - No Bedrock calls left in src/server/services/skill*.ts.
       Deploy order: worker before App Service (an old worker rejects the unknown class and the run fails).
2. [x] DONE (awaiting user test). Task `check_mining` on the skill-learning class.
       - Migration 20261109191057_07ba: skill_check_mining_runs (one running per project+stage, estimated cost) and
         skill_semantic_checks (proposed/accepted/dismissed, unique on md5(lower(statement))).
       - skillSemanticChecks.ts: startCheckMining (flag, budget >= $0.30, >= 3 changed corrections from the last 180 days,
         up to 40), frozen CHECK_MINING_INSTRUCTIONS@1; harvest keeps proposals citing >= 3 distinct sent eventIds;
         decide caps accepted at 5 per stage; sweepStuckCheckMining (2 h) on the hourly timer; spend in committedThisMonth.
       - Routes GET /semantic-checks, POST /semantic-checks/suggest, PUT /semantic-checks/:id.
       - SkillSemanticChecksPanel.tsx in the Learning tab (per-stage "Suggest checks", Add to suite / Dismiss / Remove).
3. [x] DONE (awaiting user test).
       - Terraform: optional secrets aws-access-key-id/aws-secret-access-key + env on the document worker when
         ai_platform_v2_documents_aws_* are set (variables.tf, sensitive). dev-aiv2-tf.sh reuses the visual key.
         fmt + validate pass; NOT applied.
       - Spec: 'llm-rubric' assertion type; `grader {provider:'bedrock', modelId, region, maxTokens, timeoutMs}` required
         exactly when the suite has one. App Service: resolvePromptfooGrader() = defaultBedrockTextModel() (BEDROCK_MODEL_ID,
         AWS_REGION) + 1024 tokens / 60 s.
       - Worker: run.cjs puts an IPC provider on llm-rubric assertions; promptfooExecution answers {type:'grade'} with
         promptfooBedrockGrader.ts (InvokeModel, chat-JSON prompt -> system + messages). Child still sealed.
         Checked against real promptfoo 0.124.1 locally (getGradingProvider accepts an object with id()).
       - Builder appends loadAcceptedSemanticTests after mined tests.
       Deploy order: Terraform creds -> worker image (new run.cjs) -> migrations -> App Service.
       Not done: grading tokens are not recorded as AI usage (worker has no DB); experiments do not run Promptfoo.

## Older next steps (all done)
User (12:24): "complete the entire code and improvements, then I test". Remaining after C: post-release monitoring,
Pareto candidates + Blob judge inputs, judge drift + active learning, sampled artifact judge, Promptfoo mined checks,
hub tabs, experiment service tests, changelog, AGENTS.md.
User chose (11:45): build ALL remaining items in this order: (A) closed loop + budget, (B) finish measurement, (C) ratings.
0. (A) is built (see Done). Before (B), consider an end-to-end dry run on a dev database: migrate, set a budget, start one experiment.
1. Phase 2c: optional rating control (reuse ChatMessageRating) on assistant panels, brainstorm, QA Lab, playbook views -> recordSkillSignal kind 'rating'
   via a POST route (needs a small route + hook; check RBAC per surface).
2. Build intake 'abandoned' (no hook yet — needs a sweep for stale intakes) and handoff_* for build intake.
3. Phase 1c/1d: provenance for PRD/design doc model+effort; time to approval, cost per accepted.
5. Changelog entry + AGENTS.md Skill Health row once 2c lands. Do not push without asking.

## Mistakes to avoid (learned in earlier chats)
- Main dropped per-workflow columns from project_skill_settings; never add columns there, use the registry.
- Changelog sync migrations run out of order on prod (--no-check-order); never ship one with a version below main's latest.
- Pre-commit checks data-testid on every staged TSX file; merges stage main's files too. Run `node scripts/check-data-testid.mjs` before committing.
- Bash /tmp is not visible to node on Windows; use `cygpath -m /tmp`.

## Verify with
- `npx jest src/server/__tests__/workflowEvaluation src/server/__tests__/skillHealth --silent`
- `npx tsc -p tsconfig.server.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit` (once per change set)

## Open questions for the user
- None yet.
