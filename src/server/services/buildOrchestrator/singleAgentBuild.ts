import { and, eq, inArray, ne } from 'drizzle-orm';
import type { BuildPlan } from '../../../shared/buildPlanSchema';
import {
  integrationBranchName,
  type BuildRequirement,
  type BuildRiskDecision,
} from '../../../shared/types/build';
import { db } from '../../db/drizzle';
import { buildRevisions, buildRuns, buildTasks } from '../../db/schema';
import { AzureDevOpsService } from '../azureDevOps';
import { appendBuildEvent } from '../buildEventsService';
import { buildContextNotesPath } from '../buildPlanning';
import { dispatchNext } from './dispatchWiring';
import { prepareVisualContract } from '../buildVisualBriefService';

const SINGLE_AGENT_TASK_KEY = 'build-feature';

function activeRequirementIds(
  requirements: BuildRequirement[],
  riskDecisions: BuildRiskDecision[]
): string[] {
  return [
    ...requirements
      .filter((requirement) => !requirement.retired)
      .map((requirement) => requirement.id),
    ...riskDecisions.map((decision) => decision.id),
  ];
}

/**
 * The execution plan retained for audit, evaluation, and future training.
 *
 * It intentionally describes one autonomous repository agent. The agent still
 * plans internally, but Apex does not expose or separately approve that plan.
 */
export function createSingleAgentPlan(
  buildRunId: string,
  requirements: BuildRequirement[],
  riskDecisions: BuildRiskDecision[]
): BuildPlan {
  const covers = activeRequirementIds(requirements, riskDecisions);
  if (covers.length === 0) {
    throw new Error('The approved build brief has no active requirements.');
  }

  const verificationPath = `.apex/build/${buildRunId}/verification.json`;
  return {
    classification: 'small',
    contextNotesPath: buildContextNotesPath(buildRunId),
    tasks: [
      {
        key: SINGLE_AGENT_TASK_KEY,
        role: 'implementer',
        blockers: [],
        ownedFiles: [],
        covers,
        reuse: [],
        reuseJustification: {
          searches: [
            '.cursor/CODEMAP.md',
            'docs/module-map.md',
            'docs/component-catalog.md',
          ],
          conclusion:
            'The repository build agent must inspect existing patterns before editing.',
        },
        runMode: 'own_agent',
      },
    ],
    tests: covers.map((subjectId) => ({
      subjectId,
      tier: 'unit',
      testRef: {
        path: verificationPath,
        name: subjectId,
      },
    })),
    riskConstraints: riskDecisions.map((decision) => ({
      riskDecisionId: decision.id,
      constraint: decision.decision,
    })),
  };
}

async function ensureIntegrationBranch(input: {
  buildRunId: string;
  project: string;
  repository: string;
  integrationBranch: string;
  existingBaseCommit: string | null;
}): Promise<string> {
  const ado = new AzureDevOpsService(input.project);
  const baseCommit =
    input.existingBaseCommit ??
    (await ado.getBranchHeadCommit(input.repository, input.project, 'main'));
  if (!baseCommit) {
    throw new Error('Apex could not read the repository default branch.');
  }
  await ado.ensureBranch(
    input.repository,
    input.project,
    input.integrationBranch,
    baseCommit
  );
  return baseCommit;
}

/**
 * Starts one durable repository agent through the existing build-task
 * lifecycle. Playbook remains parked on its `build` step until the resulting
 * pull request reports the build terminal.
 */
export async function startSingleAgentBuild(
  buildRunId: string
): Promise<{ status: 'launched' | 'already_running' | 'already_completed' }> {
  const [row] = await db
    .select({ run: buildRuns, revision: buildRevisions })
    .from(buildRuns)
    .innerJoin(
      buildRevisions,
      and(
        eq(buildRevisions.buildRunId, buildRuns.id),
        eq(buildRevisions.revisionNumber, buildRuns.currentRevisionNumber)
      )
    )
    .where(eq(buildRuns.id, buildRunId))
    .limit(1);
  if (!row) {
    throw new Error('Build run or current revision was not found.');
  }

  const existingSingleTask = await db.query.buildTasks.findFirst({
    where: and(
      eq(buildTasks.buildRevisionId, row.revision.id),
      eq(buildTasks.taskKey, SINGLE_AGENT_TASK_KEY)
    ),
  });
  if (existingSingleTask && existingSingleTask.status === 'running') {
    return { status: 'already_running' };
  }
  if (existingSingleTask?.status === 'merged') {
    const { onAllTasksMerged } = await import('../build/finalCheck');
    await onAllTasksMerged(row.revision.id);
    return { status: 'already_completed' };
  }

  const integrationBranch =
    row.run.integrationBranch ?? integrationBranchName(row.run.id);
  const baseCommit = await ensureIntegrationBranch({
    buildRunId: row.run.id,
    project: row.run.project,
    repository: row.run.repository,
    integrationBranch,
    existingBaseCommit: row.run.baseCommit,
  });

  const visualContract = await prepareVisualContract({
    buildRunId: row.run.id,
    project: row.run.project,
    prompt: row.run.prompt,
    requirements: row.revision.requirements ?? [],
    riskDecisions: row.revision.riskDecisions ?? [],
    skillSettingsId: row.run.skillSettingsId,
  });

  const plan = createSingleAgentPlan(
    row.run.id,
    visualContract.requirements,
    row.revision.riskDecisions ?? [],
  );
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    // Retain earlier attempts for evaluation, but keep them out of dispatch.
    await tx
      .update(buildTasks)
      .set({
        status: 'omitted',
        omittedReason:
          'Replaced by the single repository-agent execution path.',
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(buildTasks.buildRevisionId, row.revision.id),
          ne(buildTasks.taskKey, SINGLE_AGENT_TASK_KEY),
          inArray(buildTasks.status, ['pending', 'ready', 'running', 'failed'])
        )
      );

    await tx
      .update(buildRevisions)
      .set({
        classification: 'small',
        requirements: visualContract.requirements,
        plan: {
          ...(plan as unknown as Record<string, unknown>),
          visualBrief: visualContract.brief,
          taskDomain: visualContract.domain,
        },
        planValidation: { status: 'pass', violations: [] },
        contextNotesPath: plan.contextNotesPath,
        updatedAt: now,
      })
      .where(eq(buildRevisions.id, row.revision.id));

    await tx
      .update(buildRuns)
      .set({
        status: 'building',
        integrationBranch,
        baseCommit,
        updatedAt: now,
      })
      .where(eq(buildRuns.id, row.run.id));

    if (
      existingSingleTask &&
      (existingSingleTask.status === 'failed' ||
        existingSingleTask.status === 'omitted')
    ) {
      await tx
        .update(buildTasks)
        .set({
          status: 'pending',
          attempt: existingSingleTask.attempt + 1,
          dependsOn: [],
          ownedFiles: [],
          covers: plan.tasks[0].covers,
          reuse: [],
          branchName: null,
          omittedReason: null,
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        })
        .where(eq(buildTasks.id, existingSingleTask.id));
    } else if (!existingSingleTask) {
      await tx.insert(buildTasks).values({
        buildRevisionId: row.revision.id,
        taskKey: SINGLE_AGENT_TASK_KEY,
        role: 'implementer',
        dependsOn: [],
        ownedFiles: [],
        covers: plan.tasks[0].covers,
        reuse: [],
        runMode: 'own_agent',
        status: 'pending',
        attempt: 1,
      });
    } else {
      await tx
        .update(buildTasks)
        .set({
          dependsOn: [],
          ownedFiles: [],
          covers: plan.tasks[0].covers,
          reuse: [],
          updatedAt: now,
        })
        .where(eq(buildTasks.id, existingSingleTask.id));
    }
  });

  await appendBuildEvent({
    buildRunId: row.run.id,
    buildRevisionId: row.revision.id,
    eventType: 'build.scope_captured',
    message:
      'Apex captured the approved scope and started one repository build agent.',
    detail: {
      executionMode: 'single_agent',
      classification: 'small',
      taskDomain: visualContract.domain,
      requirementIds: visualContract.requirements
        .filter((requirement) => !requirement.retired)
        .map((requirement) => requirement.id),
      riskDecisionIds: (row.revision.riskDecisions ?? []).map(
        (decision) => decision.id
      ),
    },
    dedupeKey: `${row.revision.id}:scope:single-agent`,
  });
  await appendBuildEvent({
    buildRunId: row.run.id,
    buildRevisionId: row.revision.id,
    eventType: 'task.ready',
    message: 'Building — implementing the feature and its automated checks.',
    detail: { taskKey: SINGLE_AGENT_TASK_KEY },
    dedupeKey: `${row.revision.id}:task-ready:${SINGLE_AGENT_TASK_KEY}`,
  });

  const outcome = await dispatchNext(row.run.id);
  if (outcome.kind === 'suspended') {
    throw new Error(
      `The repository build agent could not start (${outcome.reason}).`
    );
  }
  if (
    outcome.kind === 'dispatched' &&
    outcome.launched.length === 0 &&
    outcome.waiting.length === 0
  ) {
    throw new Error('The repository build agent did not start.');
  }
  return { status: 'launched' };
}
