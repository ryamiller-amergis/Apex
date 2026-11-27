/**
 * The interactive side of the `cursor-agent` step (the Agent task).
 *
 * An Agent task whose Skill declares `skill-type: interactive` does not run on its own. The step
 * opens one thread, parks, and stays parked while the assignee chats. Each turn is its own agent
 * run on that thread. A finished turn updates the proposal and does not resume the Playbook. The
 * step completes only when the assignee approves a proposal that passes both checks.
 *
 * `executeCursorAgentStep` decides the mode from the pinned Skill and calls `startAgentTaskChat`.
 * Every later call here finds its step by the draft kept on the row, so an autonomous task that
 * shares the step type is never touched.
 */
import { createHash, randomUUID } from 'node:crypto';
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
  loadPlaybookSkillCompanions,
  loadPlaybookSkillContent,
  playbookSkillPath,
  resolvePlaybookAgentRunPolicy,
} from '../playbookExecutionCapabilityService';
import { agentTaskOutputKind } from '../playbookAgentTaskMode';
import { apexUserIdForEmail } from '../playbookAssigneeService';
import { loadStoredProjectSkill, projectSkillVersionIdFromPath } from '../playbookProjectSkillService';
import { getSkillConfig } from '../projectSettingsService';
import { getUserPermissions } from '../rbacService';
import { isSuperAdminUserId } from '../../utils/superAdminUser';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import type { CursorAgentStepConfig } from '../../../shared/types/playbook';
import type { PlaybookAgentRunPolicy } from '../../../shared/types/playbookExecutionCapability';
import { insertMessage } from '../chatThreadRepository';
import { extractOutcome, promptWithOutcomes } from './agentOutcome';
import { promptWithProposalInstruction } from './proposalMarker';
import { promptWithHistory } from './agentTaskConversation';
import { readV2ScorecardFiles } from './v2StepArtifacts';
import { parseStepInput, parseStepOutput } from './descriptorValidation';
import {
  checkInteractiveProposal,
  draftAfterTurn,
  interactiveProposalMode,
  isInteractiveStepDraft,
  type InteractiveStepDraft,
} from './interactiveProposal';
import { resolveDeadlineMs } from './registry';
import {
  deadlineFromNow,
  failStepRun,
  resumeStepRun,
  suspendStepRun,
  type PlaybookStepExecutionContext,
  type PlaybookStepOutcome,
} from './stepRuns';

const STEP_TYPE = 'cursor-agent';
const V2_TRANSPORT_FLAG = 'ai-runs-v2-transport';
const DAY_MS = 24 * 60 * 60 * 1000;

export class AgentTaskChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTaskChatError';
  }
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

/** The Apex account the step is assigned to. An email assignee must have signed in to Apex. */
async function resolveAssigneeUserId(config: CursorAgentStepConfig): Promise<string> {
  if (config.assigneeUserId) return config.assigneeUserId;
  const email = config.assigneeEmail?.trim() ?? '';
  if (!email) {
    throw new AgentTaskChatError(
      'This Agent task uses an interactive Skill, so it needs an assignee to chat with the agent.',
    );
  }
  const userId = await apexUserIdForEmail(email);
  if (!userId) {
    throw new AgentTaskChatError(
      `${email} has not signed in to Apex yet. They need to sign in once before this step can start.`,
    );
  }
  return userId;
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
      skillPath: input.policy.skill.path,
      skillContent: input.skillContent,
      skillSha256: input.policy.skill.sha256,
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

/**
 * A UUID that is the same every time for the same seed. The chat's message ids are UUID columns,
 * and a repeated write of one turn must store one row, not two.
 */
export function stableMessageId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Writes one side of the chat into the thread. A V2 turn runs on a worker that never writes the
 * thread, so without this the chat has no record of what the assignee or the agent said. The id is
 * kept stable by the caller, so writing the same message twice stores it once.
 */
async function recordThreadMessage(
  threadId: string,
  message: { id: string; role: 'user' | 'agent'; text: string; ts: string },
): Promise<void> {
  try {
    await insertMessage(threadId, message);
  } catch (error) {
    console.warn(`[playbook] could not record a chat message on thread ${threadId}:`, error);
  }
}

/**
 * The agent's reply to a finished turn. A V2 worker keeps the reply as an artifact of its run and
 * writes nothing to the thread, so the artifact is read first and then copied into the thread for
 * the chat and for the next turn. A run on the in-process path already wrote the thread.
 */
async function turnReply(
  agentRunId: string,
  threadId: string,
): Promise<{ text: string; outcome?: string } | null> {
  let files: Awaited<ReturnType<typeof readV2ScorecardFiles>>;
  try {
    files = await readV2ScorecardFiles(agentRunId);
  } catch (error) {
    console.warn(`[playbook] could not read the reply artifact of run ${agentRunId}:`, error);
  }
  const artifact = files?.reply?.trim();
  if (artifact) {
    await recordThreadMessage(threadId, {
      id: stableMessageId(`${agentRunId}:reply`),
      role: 'agent',
      text: artifact,
      ts: nowIso(),
    });
    return extractOutcome(artifact);
  }
  return lastReply(threadId);
}

/**
 * Opens the chat for an Agent task whose Skill is interactive. The caller has already validated
 * the Skill, resolved the policy and compared it with the one frozen at publish.
 */
export async function startAgentTaskChat(input: {
  context: PlaybookStepExecutionContext;
  config: CursorAgentStepConfig;
  skillContent: string;
  skillConfig: Awaited<ReturnType<typeof getSkillConfig>>;
  /** The step prompt, with any work item section the caller added. */
  prompt: string;
}): Promise<PlaybookStepOutcome> {
  const { context, config, skillConfig } = input;
  const assigneeUserId = await resolveAssigneeUserId(config);
  if (!(await assigneeCanRun(assigneeUserId, context.project))) {
    throw new AgentTaskChatError(
      `${config.assigneeEmail ?? `Assignee ${assigneeUserId}`} cannot run Playbooks in ${context.project}.`,
    );
  }

  const deadlineMs = resolveDeadlineMs(STEP_TYPE, config.deadlineMs, { interactive: true });
  const expiresAt = deadlineFromNow(deadlineMs);
  const model = config.model?.trim() || skillConfig?.defaultModel?.trim() || (await getDefaultModel());
  const thread = await createThread(
    assigneeUserId,
    {
      project: context.project,
      repo: skillConfig?.skillRepo ?? context.project,
      branch: skillConfig?.skillBranch ?? 'main',
      skillProvider: skillConfig?.skillProvider,
      skillPath: config.skillPath,
      freeformContext: input.prompt,
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
    assigneeUserId,
    turnCount: 0,
    rejectedRevisions: 0,
    proposalText: null,
    proposalOutcome: null,
    proposalOk: false,
    proposalReason: null,
    kind: agentTaskOutputKind(input.skillContent),
    outcomes: config.outcomes ?? [],
    lastTurnError: null,
  };
  await db.update(playbookStepRuns)
    .set({ outputInline: draftRecord(draft), updatedAt: nowIso() })
    .where(eq(playbookStepRuns.id, context.stepRunId));

  // The step's own prompt is the assignee's opening message, so the agent starts without waiting.
  // A turn that cannot start must not fail the step: the assignee sees why and sends a message.
  try {
    await launchInteractiveTurn({
      stepRunId: context.stepRunId,
      stepId: context.stepId,
      project: context.project,
      threadId: thread.id,
      userId: assigneeUserId,
      message: input.prompt,
      config,
    });
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, '');
    console.warn(`[playbook] first interactive turn could not start for ${context.stepRunId}: ${reason}`);
    await db.update(playbookStepRuns)
      .set({
        outputInline: draftRecord({
          ...draft,
          lastTurnError: `The agent could not start from the step's prompt: ${reason}. Send a message to try again.`,
        }),
        updatedAt: nowIso(),
      })
      .where(eq(playbookStepRuns.id, context.stepRunId));
  }

  const node = context.graph?.nodes.find((candidate) => candidate.id === context.stepId);
  await createNotification(
    assigneeUserId,
    {
      type: 'user-action',
      title: `Chat needed: ${node?.title?.trim() || 'An interactive Agent task'}`,
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
    throw new AgentTaskChatError('This Agent task has no chat to continue.');
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
  if (!message) throw new AgentTaskChatError('A chat message is required.');
  const row = await loadOpenStep(input.stepRunId, input.runId);
  if (!row || row.stepType !== STEP_TYPE || row.status !== 'suspended') {
    throw new AgentTaskChatError('This step is not waiting for a chat turn.');
  }
  const draft = draftOf(row.outputInline);
  if (draft.assigneeUserId !== input.userId) {
    throw new AgentTaskChatError('Only the assignee can chat on this step.');
  }
  if (!(await assigneeCanRun(input.userId, row.project))) {
    await failStepRun({
      stepRunId: row.id,
      reason: 'The assignee can no longer run Playbooks in this project.',
    });
    await db.update(playbookRuns)
      .set({ status: 'failed', completedAt: nowIso(), updatedAt: nowIso() })
      .where(and(eq(playbookRuns.id, row.runId), eq(playbookRuns.status, 'suspended')));
    throw new AgentTaskChatError('The assignee can no longer run Playbooks in this project.');
  }
  const mode = interactiveProposalMode(draft);
  if (mode === 'approve-or-cancel') {
    throw new AgentTaskChatError('This step is closed to new messages. Approve the proposal or cancel the run.');
  }
  if (row.agentRunId) {
    throw new AgentTaskChatError('A turn is already running.');
  }

  await launchInteractiveTurn({
    stepRunId: row.id,
    stepId: row.stepId,
    project: row.project,
    threadId: row.resumeToken || draft.threadId,
    userId: input.userId,
    message,
    config: parseStepInput<CursorAgentStepConfig>(STEP_TYPE, (row.inputInline ?? {}) as Record<string, unknown>),
  });
}

/**
 * Starts one agent turn on the step's thread and records it on the step. The caller has checked
 * that the step is parked, open to messages, and has no turn running.
 */
async function launchInteractiveTurn(input: {
  stepRunId: string;
  stepId: string;
  project: string;
  threadId: string;
  userId: string;
  message: string;
  config: CursorAgentStepConfig;
}): Promise<void> {
  const { config, message, threadId } = input;
  const row = { id: input.stepRunId, stepId: input.stepId, project: input.project };
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
  const prompt = promptWithOutcomes(promptWithProposalInstruction(message), config.outcomes);
  const model = config.model?.trim() || skillConfig?.defaultModel?.trim() || (await getDefaultModel());

  let agentRunId: string | null = null;
  const viaV2 = await isV2TransportEnabled(input.userId, row.project);
  const sentAt = nowIso();
  if (viaV2) {
    // A V2 turn is a new agent with no memory, so it is given the chat so far.
    const earlier = await getThread(threadId);
    agentRunId = await routeTurnThroughV2({
      userId: input.userId,
      project: row.project,
      threadId,
      prompt: promptWithHistory(prompt, earlier?.messages ?? []),
      model,
      skillContent,
      skillCompanions,
      policy,
    });
    if (!agentRunId) throw new AgentTaskChatError('The agent runtime could not start this turn.');
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
    throw new AgentTaskChatError('A turn is already running.');
  }
  // The in-process path writes the assignee's message itself. A V2 worker does not.
  if (viaV2) {
    await recordThreadMessage(threadId, { id: stableMessageId(`${agentRunId}:prompt`), role: 'user', text: message, ts: sentAt });
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
  const threadId = input.threadId || row.resumeToken || row.outputInline.threadId;
  const reply = input.failedReason ? null : await turnReply(input.agentRunId, threadId);
  // A turn that ends without any text is a failed turn. Recording it as an empty proposal would
  // hide that an agent ran at all.
  const failedReason = input.failedReason
    ?? (reply ? undefined : 'The agent finished without sending a reply. Send a message to continue.');
  const next = draftAfterTurn({
    draft: row.outputInline,
    reply,
    failedReason,
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
    throw new AgentTaskChatError('That step is not an interactive Agent task.');
  }
  if (row.status !== 'suspended') return { outcome: 'already-decided' };
  const draft = draftOf(row.outputInline);
  if (draft.assigneeUserId !== input.userId) {
    throw new AgentTaskChatError('Only the assignee can decide this proposal.');
  }
  if (!(await assigneeCanRun(input.userId, row.project))) {
    await failStepRun({
      stepRunId: row.id,
      reason: 'The assignee can no longer run Playbooks in this project.',
    });
    throw new AgentTaskChatError('The assignee can no longer run Playbooks in this project.');
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
  if (!check.ok) throw new AgentTaskChatError(check.reason);
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

/**
 * Closes the chat threads of a cancelled run. An autonomous Agent task keeps no draft, so it is
 * skipped here; its agent run is cancelled by the cancel path as before.
 */
export async function closeInteractiveThreads(steps: ReadonlyArray<{
  stepType: string;
  resumeToken: string | null;
  outputInline?: unknown;
}>): Promise<void> {
  for (const step of steps) {
    if (step.stepType !== STEP_TYPE || !step.resumeToken) continue;
    if (!isInteractiveStepDraft(step.outputInline)) continue;
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
        title: 'An interactive Agent task expires within a day',
        body: 'Approve a result or cancel the run before the deadline.',
        link: `/playbooks/runs/${row.runId}`,
      },
      { dedupeKey: `playbook-interactive-expiry:${row.id}` },
    ).catch((error: unknown) => {
      console.warn(`[playbook] interactive expiry notice failed for ${row.id}:`, error);
    });
  }
}
