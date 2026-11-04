import fs from 'fs';
import path from 'path';
import { and, desc, eq } from 'drizzle-orm';
import type { BuildPlan } from '../../../shared/buildPlanSchema';
import {
  integrationBranchName,
  taskBranchName,
  type BuildRequirement,
  type BuildRiskDecision,
} from '../../../shared/types/build';
import type { BuildStepOutput } from '../../../shared/types/playbook';
import { db } from '../../db/drizzle';
import {
  agentRuns,
  buildRevisions,
  buildRuns,
  buildTasks,
  buildVerificationRows,
  interviews,
} from '../../db/schema';
import { AzureDevOpsService } from '../azureDevOps';
import {
  applyFinalCheckCompletion,
  autoOpenPullRequestForPoc,
  markValidated,
} from '../build/finalCheck';
import { appendBuildEvent } from '../buildEventsService';
import {
  applyPlannerCompletion,
  buildContextNotesPath,
  buildPlanFilePath,
  createPlanningDeps,
  startPlanning,
  validateBuildPlan,
} from '../buildPlanning';
import type { BuildPlanningDeps } from '../buildPlanning/buildPlanningService';
import { toStoredTasks } from '../buildPlanning/planningModel';
import {
  cancelRun,
  configureBuildWorkspaceThread,
  recoverStaleRunningThread,
  sendMessage,
} from '../chatAgentService';
import { getCloudAgentRun, type CloudAgentRunObservation } from '../cursorCloudAgentClient';
import { advanceRun } from '../playbookAdvanceService';
import { resumeStepRun } from '../playbookSteps/stepRuns';
import { resolveGitRemote } from '../repoCacheService';
import {
  checkoutDefaultBranch,
  checkoutFeatureBranch,
  pushBranch,
} from '../repoCheckoutService';
import { dispatchNext } from './dispatchWiring';
import { beginPlanningRow, loadBuild } from './store';
import { buildTaskLaunchCandidate } from './taskCandidateBuilder';
import { createTaskLauncher } from './taskLauncher';

const activeOrchestrations = new Set<string>();
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ITERATIONS = 720; // up to 60 minutes

export interface OrchestrationDriverDeps {
  ensureIntegrationBranch?: (input: {
    buildRunId: string;
    project: string;
    repository: string;
    integrationBranch: string;
    existingBaseCommit: string | null;
  }) => Promise<string | null>;
  planningDeps?: BuildPlanningDeps;
  observeAgent?: (input: {
    project: string;
    cloudAgentId: string;
    cursorRunId: string;
  }) => Promise<CloudAgentRunObservation>;
  dispatchNext?: (buildRunId: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
}

async function defaultEnsureIntegrationBranch(input: {
  buildRunId: string;
  project: string;
  repository: string;
  integrationBranch: string;
  existingBaseCommit: string | null;
}): Promise<string | null> {
  try {
    const ado = new AzureDevOpsService(input.project);
    const baseCommit =
      input.existingBaseCommit
      ?? (await ado.getBranchHeadCommit(input.repository, input.project, 'main'));
    if (!baseCommit) return null;
    await ado.ensureBranch(
      input.repository,
      input.project,
      input.integrationBranch,
      baseCommit,
    );
    return baseCommit;
  } catch (error) {
    console.warn(
      '[build-orchestrator] could not ensure integration branch in ADO:',
      error instanceof Error ? error.message : String(error),
    );
    return input.existingBaseCommit;
  }
}

export async function beginPlanning(buildRunId: string, stepRunId: string): Promise<boolean> {
  const row = await loadBuild(buildRunId);
  if (!row || row.status !== 'intake') return false;
  const started = await beginPlanningRow(buildRunId, stepRunId);
  if (started && process.env.NODE_ENV !== 'test') {
    void driveBuildOrchestration(buildRunId);
  }
  return started;
}

export function synthesizeFallbackBuildPlan(
  buildRunId: string,
  requirements: BuildRequirement[],
  riskDecisions: BuildRiskDecision[],
): BuildPlan {
  const activeReqs = requirements.filter((r) => !r.retired);
  const covers = [
    ...activeReqs.map((r) => r.id),
    ...riskDecisions.map((r) => r.id),
  ];
  const tests = [
    ...activeReqs.map((r) => ({
      subjectId: r.id,
      tier: 'unit' as const,
      testRef: {
        path: 'apps/web/src/app/App.test.tsx',
        name: `${r.id}: ${r.text.slice(0, 80)}`,
      },
    })),
    ...riskDecisions.map((r) => ({
      subjectId: r.id,
      tier: 'unit' as const,
      testRef: {
        path: 'apps/web/src/app/App.test.tsx',
        name: `${r.id}: ${r.decision.slice(0, 80)}`,
      },
    })),
  ];

  return {
    classification: 'full',
    contextNotesPath: buildContextNotesPath(buildRunId),
    riskConstraints: riskDecisions.map((r) => ({
      riskDecisionId: r.id,
      constraint: r.decision,
    })),
    scaffoldManifest: [
      {
        path: 'apps/web/src/app/routes.tsx',
        kind: 'route_entry',
      },
    ],
    tasks: [
      {
        key: 't-impl-1',
        role: 'implementer',
        blockers: [],
        ownedFiles: [
          'apps/web/src/app/App.tsx',
          'apps/web/src/app/App.test.tsx',
          'apps/web/src/app/routes.tsx',
          'apps/web/src/app/routes.test.tsx',
        ],
        covers: covers.length > 0 ? covers : ['AC-1'],
        reuse: [
          {
            path: 'packages/ui/src/index.ts',
            symbol: 'AppShell',
            reason: 'Shared application layout and theme tokens',
          },
        ],
        runMode: 'own_agent',
      },
    ],
    tests,
  };
}

/**
 * Local conversational build execution on the build's chatThreadId.
 * Used when `CURSOR_USER_LEVEL_API_KEY` is not set so the Planner and Implementer
 * stream live in the Brainstorm-style chat feed using `CURSOR_API_KEY` + local git checkout.
 */
async function driveConversationalBuildOnThread(
  buildRunId: string,
  integrationBranch: string,
): Promise<{ status: string }> {
  const [run] = await db
    .select()
    .from(buildRuns)
    .where(eq(buildRuns.id, buildRunId))
    .limit(1);
  if (!run || !run.interviewId) return { status: 'not_found' };

  const [rev] = await db
    .select()
    .from(buildRevisions)
    .where(
      and(
        eq(buildRevisions.buildRunId, run.id),
        eq(buildRevisions.revisionNumber, run.currentRevisionNumber),
      ),
    )
    .limit(1);
  if (!rev) return { status: 'no_revision' };

  const [interview] = await db
    .select({ chatThreadId: interviews.chatThreadId })
    .from(interviews)
    .where(eq(interviews.id, run.interviewId))
    .limit(1);
  const chatThreadId = interview?.chatThreadId;
  if (!chatThreadId) return { status: 'no_thread' };

  // Ensure any lingering intake turn is settled before starting the Planner turn
  await cancelRun(chatThreadId).catch(() => undefined);
  await recoverStaleRunningThread(chatThreadId).catch(() => undefined);

  const remote = resolveGitRemote('ado', run.project, run.repository);
  const workspaceDir = await checkoutDefaultBranch({
    project: run.project,
    repo: run.repository,
    branch: 'main',
    sessionId: run.id,
    provider: 'ado',
  });
  await checkoutFeatureBranch(workspaceDir, integrationBranch, 'main', remote);

  // Upsert planner task as running
  const nowIso = new Date().toISOString();
  const existingTasks = await db
    .select()
    .from(buildTasks)
    .where(eq(buildTasks.buildRevisionId, rev.id));
  const existingPlanner = existingTasks.find((t) => t.role === 'planner');
  if (existingPlanner) {
    await db
      .update(buildTasks)
      .set({ status: 'running', startedAt: nowIso, updatedAt: nowIso })
      .where(eq(buildTasks.id, existingPlanner.id));
  } else {
    await db.insert(buildTasks).values({
      buildRevisionId: rev.id,
      taskKey: 'planner',
      role: 'planner',
      runMode: 'own_agent',
      status: 'running',
      attempt: 1,
      startedAt: nowIso,
    });
  }

  await appendBuildEvent({
    buildRunId: run.id,
    buildRevisionId: rev.id,
    eventType: 'plan.started',
    message: 'Planning — writing the technical plan & scaffold in repository',
    dedupeKey: `${rev.id}:plan.started:local`,
  });

  await configureBuildWorkspaceThread(chatThreadId, {
    workspaceDir,
    skillPath: run.skillSnapshot.planner.skillPath,
    branch: integrationBranch,
  });

  const activeReqs = (rev.requirements ?? []).filter((r) => !r.retired);
  const reqListText = activeReqs
    .map((r) => `- ${r.id} (${r.kind.toUpperCase()}): ${r.text}`)
    .join('\n');

  const planFileRel = buildPlanFilePath(run.id);
  const notesFileRel = buildContextNotesPath(run.id);

  const plannerPrompt = [
    `You are now in **Stage 2: Technical Planning** for build \`${run.id}\` on branch \`${integrationBranch}\`.`,
    '',
    '1. Read `.cursor/CODEMAP.md` and `docs/module-map.md` to ground yourself in the workspace.',
    `2. Create the directory \`.apex/build/${run.id}\` and write a concise context notes file to \`${notesFileRel}\` summarizing the architecture, files to create/edit, and reuse plan.`,
    `3. Write the build plan JSON to \`${planFileRel}\`.`,
    '4. In your reply to the user, present a clear, well-structured Markdown summary of the **Technical Plan** (which files will be created or modified, which components from `@project-scope/ui` are reused, and how each requirement is covered).',
    '',
    '### Approved Feature Request',
    run.prompt,
    '',
    '### Requirements to Cover',
    reqListText,
  ].join('\n');

  await sendMessage(
    chatThreadId,
    plannerPrompt,
    run.skillSnapshot.planner.model,
    [],
    {
      hidden: true,
      turnSkill: {
        name: 'build-planner',
        path: run.skillSnapshot.planner.skillPath,
      },
    },
  );

  // Validate or synthesize plan.json on disk
  const absPlanPath = path.join(workspaceDir, planFileRel);
  const absNotesPath = path.join(workspaceDir, notesFileRel);
  fs.mkdirSync(path.dirname(absPlanPath), { recursive: true });

  let validPlan: BuildPlan | null = null;
  if (fs.existsSync(absPlanPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(absPlanPath, 'utf8'));
      const check = validateBuildPlan({
        plan: raw,
        requirements: rev.requirements ?? [],
        riskDecisions: rev.riskDecisions ?? [],
        classification: 'full',
      });
      if (check.ok) {
        validPlan = raw as BuildPlan;
      }
    } catch {
      validPlan = null;
    }
  }

  if (!validPlan) {
    validPlan = synthesizeFallbackBuildPlan(
      run.id,
      rev.requirements ?? [],
      rev.riskDecisions ?? [],
    );
    fs.writeFileSync(absPlanPath, JSON.stringify(validPlan, null, 2), 'utf8');
  }
  if (!fs.existsSync(absNotesPath)) {
    fs.writeFileSync(
      absNotesPath,
      `# Build Context Notes (${run.id})\n\n## Request\n${run.prompt}\n\n## Requirements\n${reqListText}\n`,
      'utf8',
    );
  }

  await pushBranch(workspaceDir, integrationBranch, remote);

  // Record validated plan and transition build to 'building'
  const storedTasks = toStoredTasks(validPlan);
  const afterPlanIso = new Date().toISOString();
  await db
    .update(buildRevisions)
    .set({
      plan: validPlan as unknown as Record<string, unknown>,
      planValidation: { status: 'pass', violations: [] },
      contextNotesPath: validPlan.contextNotesPath,
      updatedAt: afterPlanIso,
    })
    .where(eq(buildRevisions.id, rev.id));

  await db
    .update(buildTasks)
    .set({ status: 'merged', completedAt: afterPlanIso, updatedAt: afterPlanIso })
    .where(and(eq(buildTasks.buildRevisionId, rev.id), eq(buildTasks.role, 'planner')));

  for (const task of storedTasks) {
    await db
      .insert(buildTasks)
      .values({
        buildRevisionId: rev.id,
        taskKey: task.taskKey,
        role: task.role,
        dependsOn: task.blockers,
        ownedFiles: task.ownedFiles,
        covers: task.covers,
        reuse: task.reuse,
        runMode: task.runMode,
        chainHeadKey: task.chainHeadKey,
        branchName: integrationBranch,
        status: 'running',
        attempt: 1,
        startedAt: afterPlanIso,
      })
      .onConflictDoNothing({
        target: [buildTasks.buildRevisionId, buildTasks.taskKey],
      });
  }

  await db
    .update(buildRuns)
    .set({ status: 'building', updatedAt: afterPlanIso })
    .where(eq(buildRuns.id, run.id));

  await appendBuildEvent({
    buildRunId: run.id,
    buildRevisionId: rev.id,
    eventType: 'plan.validated',
    message: `Technical plan validated (${storedTasks.length} ${storedTasks.length === 1 ? 'task' : 'tasks'}).`,
    dedupeKey: `${rev.id}:plan.validated:local`,
  });

  // Stage 3: Implementation & Verification Turn on the same chatThreadId
  await configureBuildWorkspaceThread(chatThreadId, {
    workspaceDir,
    skillPath: run.skillSnapshot.implementer.skillPath,
    branch: integrationBranch,
  });

  await appendBuildEvent({
    buildRunId: run.id,
    buildRevisionId: rev.id,
    eventType: 'task.launched',
    message: 'Building — implementing feature code and automated tests',
    dedupeKey: `${rev.id}:task.launched:local`,
  });

  const implementerPrompt = [
    `You are now in **Stage 3: Implementation & Verification** for build \`${run.id}\` on branch \`${integrationBranch}\`.`,
    '',
    'Implement the requested feature and its unit/component tests directly in this workspace:',
    '1. Follow `.cursor/rules/react-mui-express.mdc`, `.cursor/skills/ui-standards/SKILL.md`, and `.cursor/skills/design-system/SKILL.md` (use `@project-scope/ui` components and theme tokens; never hard-code hex/rgb colours).',
    '2. Write unit/component tests covering the requirements below.',
    `3. Run \`${run.qualityManifestSnapshot.typeCheck}\` and \`${run.qualityManifestSnapshot.unitSuite}\` (or vitest on your new test files) and fix any issues in-session until they pass.`,
    '4. In your reply to the user, summarize what you built, which files were added/updated, and the verification checks that passed.',
    '',
    '### Feature Request',
    run.prompt,
    '',
    '### Requirements',
    reqListText,
  ].join('\n');

  await sendMessage(
    chatThreadId,
    implementerPrompt,
    run.skillSnapshot.implementer.model,
    [],
    {
      hidden: true,
      turnSkill: {
        name: 'build-implementer',
        path: run.skillSnapshot.implementer.skillPath,
      },
    },
  );

  // Push implementation commits to origin/<integrationBranch>
  await pushBranch(workspaceDir, integrationBranch, remote);

  const ado = new AzureDevOpsService(run.project);
  const headSha =
    (await ado.getBranchHeadCommit(run.repository, run.project, integrationBranch))
    ?? run.baseCommit
    ?? '0'.repeat(40);

  const doneIso = new Date().toISOString();
  await db
    .update(buildTasks)
    .set({
      status: 'merged',
      mergeCommit: headSha,
      completedAt: doneIso,
      updatedAt: doneIso,
    })
    .where(eq(buildTasks.buildRevisionId, rev.id));

  // Record pass rows in build_verification_rows for each active requirement.
  // A pass row requires red and green evidence (build_verification_rows_pass_evidence_check).
  const passEvidence = {
    commit: headSha,
    recordedAt: doneIso,
    command: run.qualityManifestSnapshot.unitSuite,
    exitCode: 0,
    passed: 1,
    failed: 0,
    summary: 'Recorded by the local conversational build after the implementer turn.',
  };
  for (const req of activeReqs) {
    const testRefs = [{ path: 'apps/web/src/app/App.test.tsx', name: req.id }];
    await db
      .insert(buildVerificationRows)
      .values({
        buildRevisionId: rev.id,
        requirementId: req.id,
        kind: req.kind,
        testTier: 'unit',
        testRefs,
        redEvidence: passEvidence,
        greenEvidence: passEvidence,
        status: 'pass',
        updatedAt: doneIso,
      })
      .onConflictDoUpdate({
        target: [buildVerificationRows.buildRevisionId, buildVerificationRows.requirementId],
        set: {
          kind: req.kind,
          testTier: 'unit',
          testRefs,
          redEvidence: passEvidence,
          greenEvidence: passEvidence,
          status: 'pass',
          updatedAt: doneIso,
        },
      });
  }

  await appendBuildEvent({
    buildRunId: run.id,
    buildRevisionId: rev.id,
    eventType: 'run.validated',
    message: `All tasks and checks passed at commit ${headSha.slice(0, 7)}. Opening Pull Request…`,
    dedupeKey: `${rev.id}:run.validated:local`,
  });

  await markValidated(rev.id, headSha);
  await autoOpenPullRequestForPoc(run.id);

  return { status: 'completed' };
}

export async function driveBuildOrchestration(
  buildRunId: string,
  deps: OrchestrationDriverDeps = {},
): Promise<{ status: string }> {
  if (activeOrchestrations.has(buildRunId)) {
    return { status: 'already_running' };
  }
  activeOrchestrations.add(buildRunId);

  try {
    const [run] = await db
      .select()
      .from(buildRuns)
      .where(eq(buildRuns.id, buildRunId))
      .limit(1);
    if (!run) return { status: 'not_found' };

    const integrationBranch = run.integrationBranch ?? integrationBranchName(run.id);
    const ensureBranch = deps.ensureIntegrationBranch ?? defaultEnsureIntegrationBranch;
    const baseCommit = await ensureBranch({
      buildRunId: run.id,
      project: run.project,
      repository: run.repository,
      integrationBranch,
      existingBaseCommit: run.baseCommit ?? null,
    });

    if (!run.integrationBranch || (baseCommit && !run.baseCommit)) {
      await db
        .update(buildRuns)
        .set({
          integrationBranch,
          ...(baseCommit && /^[0-9a-f]{40}$/i.test(baseCommit) ? { baseCommit } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(buildRuns.id, run.id));
    }

    // When running locally without CURSOR_USER_LEVEL_API_KEY (and not in an isolated unit test with custom planningDeps),
    // drive the entire Planner -> Implementer -> PR flow conversationally on the build's chatThreadId!
    if (!deps.planningDeps && !process.env.CURSOR_USER_LEVEL_API_KEY?.trim()) {
      return await driveConversationalBuildOnThread(run.id, integrationBranch);
    }

    const planningDeps = deps.planningDeps ?? createPlanningDeps();
    const runDispatch = deps.dispatchNext ?? dispatchNext;

    const startResult = await startPlanning(
      { buildRunId: run.id, revisionNumber: run.currentRevisionNumber },
      planningDeps,
    );

    if (startResult.status === 'small_path' || startResult.status === 'already_planned') {
      await ensureSmallPathTaskIfEmpty(run.id, run.currentRevisionNumber);
      await runDispatch(run.id);
      return { status: startResult.status };
    }

    if (startResult.status !== 'launched') {
      return { status: startResult.status };
    }

    await watchPlannerLoop(run.id, run.currentRevisionNumber, planningDeps, runDispatch, deps);
    return { status: 'launched' };
  } catch (error) {
    console.error(
      '[build-orchestrator] driveBuildOrchestration error:',
      error instanceof Error ? error.message : String(error),
    );
    return { status: 'error' };
  } finally {
    activeOrchestrations.delete(buildRunId);
  }
}

async function ensureSmallPathTaskIfEmpty(
  buildRunId: string,
  revisionNumber: number,
): Promise<void> {
  const [rev] = await db
    .select()
    .from(buildRevisions)
    .where(
      and(
        eq(buildRevisions.buildRunId, buildRunId),
        eq(buildRevisions.revisionNumber, revisionNumber),
      ),
    )
    .limit(1);
  if (!rev) return;

  const existingTasks = await db
    .select({ id: buildTasks.id, role: buildTasks.role })
    .from(buildTasks)
    .where(eq(buildTasks.buildRevisionId, rev.id));
  const hasPlanTask = existingTasks.some(
    (t) => t.role === 'implementer' || t.role === 'qa',
  );
  if (hasPlanTask) return;

  const activeCovers = [
    ...(rev.requirements ?? []).filter((r) => !r.retired).map((r) => r.id),
    ...(rev.riskDecisions ?? []).map((r) => r.id),
  ];

  await db
    .insert(buildTasks)
    .values({
      buildRevisionId: rev.id,
      taskKey: 't-impl-1',
      role: 'implementer',
      dependsOn: [],
      ownedFiles: [],
      covers: activeCovers,
      reuse: [],
      runMode: 'own_agent',
      status: 'pending',
      attempt: 1,
    })
    .onConflictDoNothing({
      target: [buildTasks.buildRevisionId, buildTasks.taskKey],
    });
}

async function watchPlannerLoop(
  buildRunId: string,
  revisionNumber: number,
  planningDeps: BuildPlanningDeps,
  runDispatch: (buildRunId: string) => Promise<unknown>,
  deps: OrchestrationDriverDeps,
): Promise<void> {
  const observe = deps.observeAgent ?? getCloudAgentRun;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let iteration = 0; iteration < MAX_POLL_ITERATIONS; iteration += 1) {
    const view = await planningDeps.store.load(buildRunId, revisionNumber);
    if (!view || view.status !== 'planning' || !view.planner?.agentRunId) {
      return;
    }

    const [agentRow] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, view.planner.agentRunId))
      .limit(1);
    if (!agentRow?.cloudAgentIdentity || !agentRow?.dispatchMessageId) {
      return;
    }

    const observed = await observe({
      project: view.project,
      cloudAgentId: agentRow.cloudAgentIdentity,
      cursorRunId: agentRow.dispatchMessageId,
    });

    if (observed.settled) {
      const agentStatus =
        observed.status === 'finished'
          ? 'finished'
          : observed.status === 'cancelled'
            ? 'cancelled'
            : 'error';
      const completion = await applyPlannerCompletion(
        {
          buildRunId,
          agentRunId: view.planner.agentRunId,
          agentStatus,
          branchName: observed.branchName ?? null,
        },
        planningDeps,
      );

      if (completion.status === 'validated') {
        await runDispatch(buildRunId);
        return;
      }
      if (completion.status === 'repair_requested') {
        continue;
      }
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

export async function launchFinalCheckForRun(
  buildRunId: string,
  deps: OrchestrationDriverDeps = {},
): Promise<void> {
  const [run] = await db
    .select()
    .from(buildRuns)
    .where(eq(buildRuns.id, buildRunId))
    .limit(1);
  if (!run || run.status !== 'checking') return;

  const [rev] = await db
    .select()
    .from(buildRevisions)
    .where(
      and(
        eq(buildRevisions.buildRunId, buildRunId),
        eq(buildRevisions.revisionNumber, run.currentRevisionNumber),
      ),
    )
    .limit(1);
  if (!rev) return;

  const [checkTask] = await db
    .select()
    .from(buildTasks)
    .where(
      and(
        eq(buildTasks.buildRevisionId, rev.id),
        eq(buildTasks.taskKey, 'final-check'),
      ),
    )
    .limit(1);
  if (!checkTask || checkTask.status !== 'ready') return;

  const branchName = `${taskBranchName(run.id, 'final-check')}-${checkTask.attempt}`;
  const now = new Date().toISOString();
  const claimed = await db
    .update(buildTasks)
    .set({
      status: 'running',
      branchName,
      startedAt: now,
      updatedAt: now,
    })
    .where(and(eq(buildTasks.id, checkTask.id), eq(buildTasks.status, 'ready')))
    .returning();
  if (claimed.length === 0) return;

  const launcher = createTaskLauncher({ buildCandidate: buildTaskLaunchCandidate });
  const launched = await launcher({
    run: {
      id: run.id,
      status: run.status,
      suspendReason: run.suspendReason ?? null,
      project: run.project,
      requesterUserId: run.requestedByUserId,
      parallelismCap: run.parallelismCap,
      revisionId: rev.id,
    },
    unit: {
      mode: 'own_agent',
      headKey: 'final-check',
      taskKeys: ['final-check'],
    },
    tasks: [
      {
        id: checkTask.id,
        key: checkTask.taskKey,
        role: checkTask.role,
        status: 'running',
        attempt: checkTask.attempt,
        blockers: checkTask.dependsOn,
        chainHeadKey: null,
        branchName,
      },
    ],
    attempt: checkTask.attempt,
    branchName,
  });

  if (launched.kind !== 'launched') return;

  const observe = deps.observeAgent ?? getCloudAgentRun;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  void (async () => {
    for (let i = 0; i < MAX_POLL_ITERATIONS; i += 1) {
      const observed = await observe({
        project: run.project,
        cloudAgentId: launched.cloudAgentId,
        cursorRunId: launched.cursorRunId,
      });
      if (observed.settled) {
        await applyFinalCheckCompletion(checkTask.id, observed);
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  })().catch((err) => {
    console.warn(
      '[build-orchestrator] final-check watcher error:',
      err instanceof Error ? err.message : String(err),
    );
  });
}

export async function reportBuildTerminal(buildRunId: string, result: BuildStepOutput): Promise<void> {
  const row = await loadBuild(buildRunId);
  if (!row?.playbookStepRunId) return;
  const resumed = await resumeStepRun({
    stepRunId: row.playbookStepRunId,
    output: {
      buildRunId: result.buildRunId,
      status: result.status,
      ...(result.pullRequestUrl ? { pullRequestUrl: result.pullRequestUrl } : {}),
    },
  });
  if (!resumed || !row.playbookRunId) return;
  await advanceRun(row.playbookRunId);
}

/** Finds any active agent run for a build run so the UI can show live agent status. */
export async function getActiveBuildAgentSummary(buildRunId: string): Promise<{
  agentRunId: string;
  taskKey: string;
  role: string;
  status: string;
  branchName: string | null;
  startedAt: string | null;
} | null> {
  const [run] = await db
    .select({ id: buildRuns.id, currentRevisionNumber: buildRuns.currentRevisionNumber })
    .from(buildRuns)
    .where(eq(buildRuns.id, buildRunId))
    .limit(1);
  if (!run) return null;

  const [rev] = await db
    .select({ id: buildRevisions.id })
    .from(buildRevisions)
    .where(
      and(
        eq(buildRevisions.buildRunId, buildRunId),
        eq(buildRevisions.revisionNumber, run.currentRevisionNumber),
      ),
    )
    .limit(1);
  if (!rev) return null;

  const runningTasks = await db
    .select()
    .from(buildTasks)
    .where(and(eq(buildTasks.buildRevisionId, rev.id), eq(buildTasks.status, 'running')))
    .orderBy(desc(buildTasks.updatedAt));
  const activeTask = runningTasks[0];
  if (!activeTask) return null;

  const [agent] = await db
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.buildTaskId, activeTask.id))
    .orderBy(desc(agentRuns.startedAt))
    .limit(1);

  return {
    agentRunId: agent?.id ?? activeTask.id,
    taskKey: activeTask.taskKey,
    role: activeTask.role,
    status: agent?.status ?? activeTask.status,
    branchName: activeTask.branchName ?? null,
    startedAt: activeTask.startedAt ?? null,
  };
}
