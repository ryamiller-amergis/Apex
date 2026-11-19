/**
 * The `interactive-agent` step type.
 *
 * The step opens one thread, parks, and stays parked while the assignee chats. Each turn is its
 * own agent run on that thread. A finished turn updates the proposal and does not resume the
 * Playbook. The step completes only when the assignee approves a proposal that passes both checks.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { playbookRuns, playbookStepRuns } from '../../db/schema';
import { enqueue } from '../agentRunLifecycleService';
import { routeBackgroundWorkflow } from '../backgroundWorkflowRouter';
import { getDefaultModel } from '../appSettingsService';
import { cancelRun, closeThread, createThread, getThread, prepareBackgroundWorkflowTurn } from '../chatAgentService';
import { isFeatureEnabled } from '../featureFlagService';
import { createNotification } from '../notificationService';
import {
  PlaybookExecutionCapabilityError,
  loadPlaybookSkillCompanions,
  loadPlaybookSkillContent,
  playbookSkillPath,
  resolvePlaybookAgentRunPolicy,
} from '../playbookExecutionCapabilityService';
import { PlaybookMcpCapabilityError, resolvePlaybookMcpCapability } from '../playbookMcpCapabilityService';
import { loadStoredProjectSkill, projectSkillVersionIdFromPath } from '../playbookProjectSkillService';
import { getSkillConfig } from '../projectSettingsService';
import { getUserPermissions } from '../rbacService';
import { isSuperAdminUserId } from '../../utils/superAdminUser';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import type { PlaybookAgentRunPolicy } from '../../../shared/types/playbookExecutionCapability';
import { extractOutcome, promptWithOutcomes } from './agentOutcome';
import { parseStepInput, parseStepOutput } from './descriptorValidation';
import {
  checkInteractiveProposal,
  draftAfterTurn,
  interactiveProposalMode,
  isInteractiveStepDraft,
  type InteractiveStepDraft,
} from './interactiveProposal';
import { parsePlaybookSkillFrontmatter } from '../playbookSkillFrontmatter';
import { assertSkillAllowed, resolveDeadlineMs } from './registry';
import {
  deadlineFromNow,
  failStepRun,
  resumeStepRun,
  suspendStepRun,
  type PlaybookStepExecutionContext,
  type PlaybookStepOutcome,
} from './stepRuns';

const STEP_TYPE = 'interactive-agent';
const V2_TRANSPORT_FLAG = 'ai-runs-v2-transport';
const DAY_MS = 24 * 60 * 60 * 1000;

export class InteractiveAgentStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InteractiveAgentStepError';
  }
}

interface InteractiveConfig {
  skillPath?: string;
  prompt: string;
  model?: string;
  mcpProfile: 'repository-read-only';
  assigneeUserId: string;
  deadlineMs?: number;
  outcomes?: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function draftRecord(draft: InteractiveStepDraft): Record<string, unknown> {
  return { ...draft } as Record<string, unknown>;
}

async function assigneeCanRun(userId: string, project: string): Promise<boolean> {
  if (await isSuperAdminUserId(userId)) return true;
  const permissions = await getUserPermissions(userId, project);
  return permissions.has('playbooks:run');
}

async function isV2TransportEnabled(userId: string, project: string): Promise<boolean> {
  return isFeatureEnabled(V2_TRANSPORT_FLAG, { userId, project });
}

async function routeTurnThroughV2(input: {
  userId: string;
  project: string;
  threadId: string;
  prompt: string;
  model: string;
  skillContent: string;
  skillCompanions: Array<{ path: string; content: string }>;
  policy: PlaybookAgentRunPolicy;
}): Promise<string | null> {
  const decision = await routeBackgroundWorkflow({
    userId: input.userId,
    workflowClass: 'playbook-step',
    destinationRun: { runType: 'chat', runId: input.threadId, project: input.project },
    agentRunId: randomUUID(),
    threadId: input.threadId,
    playbookAgentPolicy: input.policy,
    prepareWorker: async () => ({
      ...(await prepareBackgroundWorkflowTurn(input.threadId, input.prompt)),
      model: input.model,
      skillContent: input.skillContent,
      skillCompanions: input.skillCompanions,
      playbookAgentPolicy: input.policy,
    }),
    runInProcess: () => undefined,
    reportRecoverablePreparationFailure: () => undefined,
  });
  return decision.route === 'worker' ? decision.runId : null;
}

async function lastReply(threadId: string): Promise<{ text: string; outcome?: string } | null> {
  const thread = await getThread(threadId);
  const reply = [...(thread?.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'agent' && !message.hidden && message.text.trim());
  if (!reply) return null;
  return extractOutcome(reply.text);
}

export async function executeInteractiveAgentStep(
  context: PlaybookStepExecutionContext,
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<InteractiveConfig>(STEP_TYPE, context.config);
  if (config.skillPath) assertSkillAllowed(STEP_TYPE, config.skillPath);
  const capability = resolvePlaybookMcpCapability(config.mcpProfile);
  if (capability.mode !== 'read') {
    throw new PlaybookMcpCapabilityError(context.stepId, config.mcpProfile, capability.mode);
  }
  if (!(await assigneeCanRun(config.assigneeUserId, context.project))) {
    throw new InteractiveAgentStepError(
      `Assignee ${config.assigneeUserId} cannot run Playbooks in ${context.project}.`,
    );
  }

  const skillPath = playbookSkillPath(config.skillPath);
  const skillConfig = await getSkillConfig(context.project);
  const versionId = projectSkillVersionIdFromPath(skillPath);
  const stored = versionId ? await loadStoredProjectSkill(versionId) : null;
  const skillContent = stored?.content ?? await loadPlaybookSkillContent(skillPath);
  const resolvedPolicy = resolvePlaybookAgentRunPolicy({
    nodeId: context.stepId,
    skillPath,
    skillContent,
    mcpProfile: config.mcpProfile,
    repository: skillConfig?.skillRepo ?? context.project,
    provider: skillConfig?.skillProvider,
    enforce: true,
    ...(stored && versionId
      ? { bundle: { skillVersionId: versionId, companions: stored.companions } }
      : {}),
  });
  const frozenPolicy = context.graph?.nodes.find((node) => node.id === context.stepId)?.agentPolicy;
  if (
    frozenPolicy
    && (
      frozenPolicy.skill.path !== resolvedPolicy.skill.path
      || frozenPolicy.skill.sha256 !== resolvedPolicy.skill.sha256
      || (
        (frozenPolicy.bundleSha256 ?? resolvedPolicy.bundleSha256) !== undefined
        && frozenPolicy.bundleSha256 !== resolvedPolicy.bundleSha256
      )
    )
  ) {
    throw new PlaybookExecutionCapabilityError(
      `The published capability policy for step "${context.stepId}" no longer matches its Skill.`,
    );
  }

  let kind: string | null = null;
  try {
    kind = parsePlaybookSkillFrontmatter(skillContent).outputKind;
  } catch {
    kind = null;
  }

  const deadlineMs = resolveDeadlineMs(STEP_TYPE, config.deadlineMs);
  const expiresAt = deadlineFromNow(deadlineMs);
  const model = config.model?.trim() || skillConfig?.defaultModel?.trim() || (await getDefaultModel());
  const thread = await createThread(
    config.assigneeUserId,
    {
      project: context.project,
      repo: skillConfig?.skillRepo ?? context.project,
      branch: skillConfig?.skillBranch ?? 'main',
      skillProvider: skillConfig?.skillProvider,
      skillPath: config.skillPath,
      freeformContext: config.prompt,
      model,
      playbookMcpProfile: config.mcpProfile,
    },
    { skipAutoKickoff: true },
  );

  await suspendStepRun({
    stepRunId: context.stepRunId,
    expiresAt,
    resumeToken: thread.id,
  });
  const draft: InteractiveStepDraft = {
    threadId: thread.id,
    assigneeUserId: config.assigneeUserId,
    turnCount: 0,
    rejectedRevisions: 0,
    proposalText: null,
    proposalOutcome: null,
    proposalOk: false,
    proposalReason: null,
    kind,
    outcomes: config.outcomes ?? [],
    lastTurnError: null,
  };
  await db.update(playbookStepRuns)
    .set({ outputInline: draftRecord(draft), updatedAt: nowIso() })
    .where(eq(playbookStepRuns.id, context.stepRunId));

  const node = context.graph?.nodes.find((candidate) => candidate.id === context.stepId);
  await createNotification(
    config.assigneeUserId,
    {
      type: 'user-action',
      title: `Chat needed: ${node?.title?.trim() || 'An interactive agent task'}`,
      body: 'A Playbook run is waiting for you to chat with an agent and approve its result.',
      link: `/playbooks/runs/${context.runId}`,
    },
    { dedupeKey: `playbook-interactive-open:${context.stepRunId}` },
  ).catch((error: unknown) => {
    console.warn(`[playbook] interactive open notice failed for ${context.stepRunId}:`, error);
  });

  return { kind: 'suspended', expiresAt };
}

async function loadOpenStep(stepRunId: string, runId: string) {
  const [row] = await db
    .select({
      id: playbookStepRuns.id,
      runId: playbookStepRuns.runId,
      stepId: playbookStepRuns.stepId,
      stepType: playbookStepRuns.stepType,
      status: playbookStepRuns.status,
      agentRunId: playbookStepRuns.agentRunId,
      resumeToken: playbookStepRuns.resumeToken,
      outputInline: playbookStepRuns.outputInline,
      inputInline: playbookStepRuns.inputInline,
      project: playbookRuns.project,
    })
    .from(playbookStepRuns)
    .innerJoin(playbookRuns, eq(playbookStepRuns.runId, playbookRuns.id))
    .where(and(eq(playbookStepRuns.id, stepRunId), eq(playbookStepRuns.runId, runId)))
    .limit(1);
  return row ?? null;
}

function draftOf(output: unknown): InteractiveStepDraft {
  if (!isInteractiveStepDraft(output)) {
    throw new InteractiveAgentStepError('This interactive step has no chat to continue.');
  }
  return output;
}

export async function sendInteractiveTurn(input: {
  runId: string;
  stepRunId: string;
  userId: string;
  message: string;
}): Promise<void> {
  const message = input.message.trim();
  if (!message) throw new InteractiveAgentStepError('A chat message is required.');
  const row = await loadOpenStep(input.stepRunId, input.runId);
  if (!row || row.stepType !== STEP_TYPE || row.status !== 'suspended') {
    throw new InteractiveAgentStepError('This step is not waiting for a chat turn.');
  }
  const draft = draftOf(row.outputInline);
  if (draft.assigneeUserId !== input.userId) {
    throw new InteractiveAgentStepError('Only the assignee can chat on this step.');
  }
  if (!(await assigneeCanRun(input.userId, row.project))) {
    await failStepRun({
      stepRunId: row.id,
      reason: 'The assignee can no longer run Playbooks in this project.',
    });
    await db.update(playbookRuns)
      .set({ status: 'failed', completedAt: nowIso(), updatedAt: nowIso() })
      .where(and(eq(playbookRuns.id, row.runId), eq(playbookRuns.status, 'suspended')));
    throw new InteractiveAgentStepError('The assignee can no longer run Playbooks in this project.');
  }
  const mode = interactiveProposalMode(draft);
  if (mode === 'approve-or-cancel') {
    throw new InteractiveAgentStepError('This step is closed to new messages. Approve the proposal or cancel the run.');
  }
  if (row.agentRunId) {
    throw new InteractiveAgentStepError('A turn is already running.');
  }

  const config = parseStepInput<InteractiveConfig>(STEP_TYPE, (row.inputInline ?? {}) as Record<string, unknown>);
  const skillPath = playbookSkillPath(config.skillPath);
  const skillConfig = await getSkillConfig(row.project);
  const versionId = projectSkillVersionIdFromPath(skillPath);
  const stored = versionId ? await loadStoredProjectSkill(versionId) : null;
  const skillContent = stored?.content ?? await loadPlaybookSkillContent(skillPath);
  const skillCompanions = stored
    ? stored.companions.map((companion) => ({ path: companion.path, content: companion.content }))
    : await loadPlaybookSkillCompanions(skillPath);
  const policy = resolvePlaybookAgentRunPolicy({
    nodeId: row.stepId,
    skillPath,
    skillContent,
    mcpProfile: config.mcpProfile,
    repository: skillConfig?.skillRepo ?? row.project,
    provider: skillConfig?.skillProvider,
    enforce: true,
    ...(stored && versionId
      ? { bundle: { skillVersionId: versionId, companions: stored.companions } }
      : {}),
  });
  const prompt = mode === 'forced-proposal'
    ? `${message}\n\nThe conversation has reached its turn limit. Reply with your final proposal now.`
    : promptWithOutcomes(message, config.outcomes);
  const model = config.model?.trim() || skillConfig?.defaultModel?.trim() || (await getDefaultModel());
  const threadId = row.resumeToken || draft.threadId;

  let agentRunId: string | null = null;
  if (await isV2TransportEnabled(input.userId, row.project)) {
    agentRunId = await routeTurnThroughV2({
      userId: input.userId,
      project: row.project,
      threadId,
      prompt,
      model,
      skillContent,
      skillCompanions,
      policy,
    });
    if (!agentRunId) throw new InteractiveAgentStepError('The agent runtime could not start this turn.');
  } else {
    const snapshot: ExecutionSnapshot = {
      prompt,
      model,
      workspaceRef: threadId,
      workflowClass: 'playbook-step',
      skillPath,
      skillContent,
      skillSha256: policy.skill.sha256,
      projectId: row.project,
      threadId,
      playbookAgentPolicy: policy,
    };
    ({ runId: agentRunId } = await enqueue({
      threadId,
      projectId: row.project,
      snapshot,
      timeoutAt: deadlineFromNow(60 * 60 * 1000),
      lane: 'background',
    }));
  }

  const claimed = await db.update(playbookStepRuns)
    .set({ agentRunId, updatedAt: nowIso() })
    .where(and(
      eq(playbookStepRuns.id, row.id),
      eq(playbookStepRuns.status, 'suspended'),
      isNull(playbookStepRuns.agentRunId),
    ))
    .returning({ id: playbookStepRuns.id });
  if (claimed.length === 0) {
    throw new InteractiveAgentStepError('A turn is already running.');
  }
}

/** A finished turn stays on the step. The Playbook resumes only when the assignee approves. */
export async function recordInteractiveTurnFinished(input: {
  stepRunId: string;
  agentRunId: string;
  threadId?: string | null;
  failedReason?: string;
}): Promise<boolean> {
  const [row] = await db
    .select({
      outputInline: playbookStepRuns.outputInline,
      resumeToken: playbookStepRuns.resumeToken,
    })
    .from(playbookStepRuns)
    .where(and(
      eq(playbookStepRuns.id, input.stepRunId),
      eq(playbookStepRuns.status, 'suspended'),
      eq(playbookStepRuns.agentRunId, input.agentRunId),
    ))
    .limit(1);
  if (!row || !isInteractiveStepDraft(row.outputInline)) return false;
  const reply = input.failedReason
    ? null
    : await lastReply(input.threadId || row.resumeToken || row.outputInline.threadId);
  const next = draftAfterTurn({
    draft: row.outputInline,
    reply,
    failedReason: input.failedReason,
  });
  const updated = await db.update(playbookStepRuns)
    .set({ agentRunId: null, outputInline: draftRecord(next), updatedAt: nowIso() })
    .where(and(
      eq(playbookStepRuns.id, input.stepRunId),
      eq(playbookStepRuns.status, 'suspended'),
      eq(playbookStepRuns.agentRunId, input.agentRunId),
    ))
    .returning({ id: playbookStepRuns.id });
  return updated.length > 0;
}

export async function decideInteractiveProposal(input: {
  runId: string;
  stepRunId: string;
  userId: string;
  decision: 'approved' | 'rejected';
}): Promise<{ outcome: 'recorded' | 'already-decided'; stepId?: string }> {
  const row = await loadOpenStep(input.stepRunId, input.runId);
  if (!row || row.stepType !== STEP_TYPE) {
    throw new InteractiveAgentStepError('That step is not an interactive agent task.');
  }
  if (row.status !== 'suspended') return { outcome: 'already-decided' };
  const draft = draftOf(row.outputInline);
  if (draft.assigneeUserId !== input.userId) {
    throw new InteractiveAgentStepError('Only the assignee can decide this proposal.');
  }
  if (!(await assigneeCanRun(input.userId, row.project))) {
    await failStepRun({
      stepRunId: row.id,
      reason: 'The assignee can no longer run Playbooks in this project.',
    });
    throw new InteractiveAgentStepError('The assignee can no longer run Playbooks in this project.');
  }
  if (input.decision === 'rejected') {
    const next: InteractiveStepDraft = {
      ...draft,
      rejectedRevisions: draft.rejectedRevisions + 1,
    };
    await db.update(playbookStepRuns)
      .set({ outputInline: draftRecord(next), updatedAt: nowIso() })
      .where(and(eq(playbookStepRuns.id, row.id), eq(playbookStepRuns.status, 'suspended')));
    return { outcome: 'recorded', stepId: row.stepId };
  }
  const check = checkInteractiveProposal({
    text: draft.proposalText ?? '',
    outcome: draft.proposalOutcome ?? undefined,
    outcomes: draft.outcomes,
    kind: draft.kind,
  });
  if (!check.ok) throw new InteractiveAgentStepError(check.reason);
  const output = parseStepOutput(STEP_TYPE, {
    threadId: draft.threadId,
    approvedBy: input.userId,
    completedAt: nowIso(),
    output: draft.proposalText,
    ...(draft.proposalOutcome ? { outcome: draft.proposalOutcome } : {}),
  });
  const moved = await resumeStepRun({ stepRunId: row.id, output });
  return moved
    ? { outcome: 'recorded', stepId: row.stepId }
    : { outcome: 'already-decided' };
}

export async function closeInteractiveThreads(steps: ReadonlyArray<{
  stepType: string;
  resumeToken: string | null;
}>): Promise<void> {
  for (const step of steps) {
    if (step.stepType !== STEP_TYPE || !step.resumeToken) continue;
    await cancelRun(step.resumeToken).catch((error: unknown) => {
      console.warn(`[playbook] interactive turn cancel failed for ${step.resumeToken}:`, error);
    });
    await closeThread(step.resumeToken).catch((error: unknown) => {
      console.warn(`[playbook] interactive thread close failed for ${step.resumeToken}:`, error);
    });
  }
}

/** One notice during the last day before the step expires. */
export async function warnInteractiveExpiring(now: Date): Promise<void> {
  const soon = new Date(now.getTime() + DAY_MS).toISOString();
  const rows = await db
    .select({
      id: playbookStepRuns.id,
      runId: playbookStepRuns.runId,
      outputInline: playbookStepRuns.outputInline,
    })
    .from(playbookStepRuns)
    .where(and(
      eq(playbookStepRuns.stepType, STEP_TYPE),
      eq(playbookStepRuns.status, 'suspended'),
    ));
  for (const row of rows) {
    if (!isInteractiveStepDraft(row.outputInline)) continue;
    const [fresh] = await db
      .select({ expiresAt: playbookStepRuns.expiresAt })
      .from(playbookStepRuns)
      .where(eq(playbookStepRuns.id, row.id))
      .limit(1);
    if (!fresh?.expiresAt || fresh.expiresAt <= now.toISOString() || fresh.expiresAt > soon) continue;
    await createNotification(
      row.outputInline.assigneeUserId,
      {
        type: 'user-action',
        title: 'An interactive agent task expires within a day',
        body: 'Approve a result or cancel the run before the deadline.',
        link: `/playbooks/runs/${row.runId}`,
      },
      { dedupeKey: `playbook-interactive-expiry:${row.id}` },
    ).catch((error: unknown) => {
      console.warn(`[playbook] interactive expiry notice failed for ${row.id}:`, error);
    });
  }
}
