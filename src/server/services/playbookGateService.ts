import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  playbookDefinitionVersions,
  playbookDefinitions,
  playbookGateApprovers,
  playbookRuns,
  playbookStepRuns,
} from '../db/schema';
import {
  getApprovalModeForProject,
  getApproverPoolForProject,
  getApproverUserIdsForProject,
} from './projectSettingsService';
import { getStepTypeDescriptor } from './playbookSteps/registry';
import { resumeStepRun } from './playbookSteps/stepRuns';
import { getAssignmentsForProject } from './userProjectAssignmentService';
import type { ApprovalMode, ReviewerDocumentType } from '../../shared/types/approvals';
import type {
  ApprovalGateStepConfig,
  PlaybookGateDetail,
  PlaybookSchemaDisplayField,
} from '../../shared/types/playbook';

export class PlaybookGateEmptyPoolError extends Error {
  constructor(pool: ReviewerDocumentType) {
    super(`Approval gate cannot suspend because approver pool "${pool}" has no current project members.`);
    this.name = 'PlaybookGateEmptyPoolError';
  }
}

export class PlaybookGateForbiddenError extends Error {
  constructor() {
    super('Only a currently eligible resolved approver may view or decide this gate.');
    this.name = 'PlaybookGateForbiddenError';
  }
}

export class PlaybookGateNotFoundError extends Error {
  constructor() {
    super('No pending approval gate exists at this run and step.');
    this.name = 'PlaybookGateNotFoundError';
  }
}

export class PlaybookGateInputRenderError extends Error {
  constructor() {
    super('The resolved gate inputs do not conform to the step input schema.');
    this.name = 'PlaybookGateInputRenderError';
  }
}

export async function isProductionGateStepRun(stepRunId: string): Promise<boolean> {
  const [row] = await db.select({ pool: playbookStepRuns.gatePoolKey })
    .from(playbookStepRuns)
    .where(eq(playbookStepRuns.id, stepRunId))
    .limit(1);
  return Boolean(row?.pool);
}

function labelFor(path: string): string {
  const parts = path.split('.');
  const leaf = parts[parts.length - 1] ?? path;
  return leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());
}

function displayFields(value: unknown, prefix = ''): PlaybookSchemaDisplayField[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      return displayFields(child, path);
    }
    return [{ path, label: labelFor(path), value: child == null ? '' : String(child) }];
  });
}

async function currentPoolUserIds(project: string, pool: ReviewerDocumentType): Promise<Set<string>> {
  const [poolUserIds, assignments] = await Promise.all([
    getApproverUserIdsForProject(project, pool),
    getAssignmentsForProject(project),
  ]);
  const projectMembers = new Set(assignments.map((assignment) => assignment.userId));
  return new Set(poolUserIds.filter((userId) => projectMembers.has(userId)));
}

export async function snapshotGateAtSuspend(input: {
  project: string;
  stepRunId: string;
  config: ApprovalGateStepConfig;
}): Promise<{ approvalMode: ApprovalMode; approverUserIds: string[] }> {
  if (!input.config.approverPool || !input.config.gatedStepId) {
    throw new Error('Production approval gates require approverPool and gatedStepId.');
  }
  const pool = await getApproverPoolForProject(input.project, input.config.approverPool);
  const sourceGroups = new Map<string, Set<string>>();
  const userIds = await currentPoolUserIds(input.project, input.config.approverPool);
  for (const group of pool.groups) {
    for (const member of group.members) {
      if (!userIds.has(member.userId)) continue;
      const groups = sourceGroups.get(member.userId) ?? new Set<string>();
      groups.add(group.id);
      sourceGroups.set(member.userId, groups);
    }
  }
  if (userIds.size === 0) throw new PlaybookGateEmptyPoolError(input.config.approverPool);
  const approvalMode = await getApprovalModeForProject(input.project, input.config.approverPool);

  await db.transaction(async (tx) => {
    await tx.update(playbookStepRuns).set({
      gatePoolKey: input.config.approverPool,
      gateApprovalMode: approvalMode,
    }).where(eq(playbookStepRuns.id, input.stepRunId));
    await tx.insert(playbookGateApprovers).values([...userIds].map((approverUserId) => ({
      stepRunId: input.stepRunId,
      approverUserId,
      sourceGroupIds: [...(sourceGroups.get(approverUserId) ?? [])],
    }))).onConflictDoNothing();
  });
  return { approvalMode, approverUserIds: [...userIds] };
}

async function gateContext(project: string, runId: string, stepRunId: string) {
  const [row] = await db.select({
    runId: playbookRuns.id,
    stepRunId: playbookStepRuns.id,
    stepId: playbookStepRuns.stepId,
    status: playbookStepRuns.status,
    expiresAt: playbookStepRuns.expiresAt,
    gatePoolKey: playbookStepRuns.gatePoolKey,
    approvalMode: playbookStepRuns.gateApprovalMode,
    gateInput: playbookStepRuns.inputInline,
  }).from(playbookStepRuns)
    .innerJoin(playbookRuns, eq(playbookRuns.id, playbookStepRuns.runId))
    .where(and(
      eq(playbookRuns.project, project),
      eq(playbookRuns.id, runId),
      eq(playbookStepRuns.id, stepRunId),
    )).limit(1);
  if (!row || !row.gatePoolKey || !row.approvalMode || !row.expiresAt) {
    throw new PlaybookGateNotFoundError();
  }
  return {
    ...row,
    expiresAt: row.expiresAt as string,
    gatePoolKey: row.gatePoolKey as ReviewerDocumentType,
    approvalMode: row.approvalMode as ApprovalMode,
  };
}

async function assertEligible(
  project: string,
  stepRunId: string,
  pool: ReviewerDocumentType,
  userId: string,
): Promise<void> {
  const [snapshot] = await db.select({ id: playbookGateApprovers.id })
    .from(playbookGateApprovers)
    .where(and(
      eq(playbookGateApprovers.stepRunId, stepRunId),
      eq(playbookGateApprovers.approverUserId, userId),
    )).limit(1);
  const current = await currentPoolUserIds(project, pool);
  if (!snapshot || !current.has(userId)) throw new PlaybookGateForbiddenError();
}

export async function getGateDetail(input: {
  project: string;
  runId: string;
  stepRunId: string;
  userId: string;
}): Promise<PlaybookGateDetail> {
  const gate = await gateContext(input.project, input.runId, input.stepRunId);
  await assertEligible(input.project, gate.stepRunId, gate.gatePoolKey, input.userId);
  const gateConfig = gate.gateInput as ApprovalGateStepConfig | null;
  if (!gateConfig?.gatedStepId) throw new PlaybookGateInputRenderError();

  const [gated] = await db.select({
    stepType: playbookStepRuns.stepType,
    input: playbookStepRuns.inputInline,
  }).from(playbookStepRuns).where(and(
    eq(playbookStepRuns.runId, input.runId),
    eq(playbookStepRuns.stepId, gateConfig.gatedStepId),
  )).limit(1);
  if (!gated) throw new PlaybookGateInputRenderError();
  const parsed = getStepTypeDescriptor(gated.stepType).inputSchema.safeParse(gated.input ?? {});
  if (!parsed.success) throw new PlaybookGateInputRenderError();

  const current = await currentPoolUserIds(input.project, gate.gatePoolKey);
  if (current.size === 0) throw new PlaybookGateEmptyPoolError(gate.gatePoolKey);
  const approvers = await db.select({
    userId: playbookGateApprovers.approverUserId,
    decision: playbookGateApprovers.decision,
  }).from(playbookGateApprovers).where(eq(playbookGateApprovers.stepRunId, gate.stepRunId));
  const mine = approvers.find((approver) => approver.userId === input.userId);
  const fields = displayFields(parsed.data);
  return {
    runId: gate.runId,
    stepRunId: gate.stepRunId,
    subject: gateConfig.subject ?? `Review ${gateConfig.gatedStepId}`,
    deadline: gate.expiresAt,
    approvalMode: gate.approvalMode,
    eligibleApproverCount: approvers.filter((approver) => current.has(approver.userId)).length,
    currentUserDecision: mine?.decision ?? null,
    fields,
    hasInputFields: fields.length > 0,
    canDecide: gate.status === 'suspended' && !mine?.decision,
  };
}

export async function decideGate(input: {
  project: string;
  runId: string;
  stepRunId: string;
  userId: string;
  decision: 'approved' | 'rejected';
  comment?: string;
}): Promise<{ outcome: 'recorded' | 'already-decided'; advanced: boolean; stepId?: string }> {
  const gate = await gateContext(input.project, input.runId, input.stepRunId);
  await assertEligible(input.project, gate.stepRunId, gate.gatePoolKey, input.userId);
  if (gate.status !== 'suspended') return { outcome: 'already-decided', advanced: false };

  const updated = await db.update(playbookGateApprovers).set({
    decision: input.decision,
    comment: input.comment,
    decidedAt: new Date().toISOString(),
  }).where(and(
    eq(playbookGateApprovers.stepRunId, gate.stepRunId),
    eq(playbookGateApprovers.approverUserId, input.userId),
    isNull(playbookGateApprovers.decision),
  )).returning({ id: playbookGateApprovers.id });
  if (updated.length === 0) return { outcome: 'already-decided', advanced: false };

  const current = await currentPoolUserIds(input.project, gate.gatePoolKey);
  if (current.size === 0) throw new PlaybookGateEmptyPoolError(gate.gatePoolKey);
  const decisions = await db.select({
    userId: playbookGateApprovers.approverUserId,
    decision: playbookGateApprovers.decision,
  }).from(playbookGateApprovers).where(eq(playbookGateApprovers.stepRunId, gate.stepRunId));
  const eligible = decisions.filter((decision) => current.has(decision.userId));
  const complete = input.decision === 'rejected'
    || gate.approvalMode === 'any_one'
    || eligible.every((decision) => decision.decision === 'approved');
  if (!complete) return { outcome: 'recorded', advanced: false };

  const moved = await resumeStepRun({
    stepRunId: gate.stepRunId,
    output: { decision: input.decision, decidedBy: input.userId },
  });
  return moved
    ? { outcome: 'recorded', advanced: true, stepId: gate.stepId }
    : { outcome: 'already-decided', advanced: false };
}

export async function listPendingGateRows(input: {
  project: string;
  userId: string;
  limit: number;
}): Promise<{ rows: Array<{
  id: string;
  runId: string;
  title: string;
  deadline: string;
  createdAt: string;
}>; total: number }> {
  const currentPools = await Promise.all(
    (['prd', 'design_doc', 'design_prototype', 'test_case', 'adr'] as ReviewerDocumentType[])
      .map(async (pool) => [pool, await currentPoolUserIds(input.project, pool)] as const),
  );
  const eligiblePools = currentPools.filter(([, users]) => users.has(input.userId)).map(([pool]) => pool);
  if (eligiblePools.length === 0) return { rows: [], total: 0 };

  const predicate = and(
    eq(playbookRuns.project, input.project),
    eq(playbookRuns.status, 'suspended'),
    eq(playbookStepRuns.status, 'suspended'),
    eq(playbookGateApprovers.approverUserId, input.userId),
    isNull(playbookGateApprovers.decision),
    inArray(playbookStepRuns.gatePoolKey, eligiblePools),
  );
  const rows = await db.select({
    id: playbookStepRuns.id,
    runId: playbookRuns.id,
    title: playbookDefinitions.name,
    deadline: playbookStepRuns.expiresAt,
    createdAt: playbookStepRuns.createdAt,
  }).from(playbookGateApprovers)
    .innerJoin(playbookStepRuns, eq(playbookStepRuns.id, playbookGateApprovers.stepRunId))
    .innerJoin(playbookRuns, eq(playbookRuns.id, playbookStepRuns.runId))
    .innerJoin(playbookDefinitionVersions, eq(playbookDefinitionVersions.id, playbookRuns.definitionVersionId))
    .innerJoin(playbookDefinitions, eq(playbookDefinitions.id, playbookDefinitionVersions.definitionId))
    .where(predicate)
    .orderBy(asc(playbookStepRuns.expiresAt), asc(playbookStepRuns.createdAt), asc(playbookStepRuns.id))
    .limit(input.limit);
  const [totals] = await db.select({ value: count() }).from(playbookGateApprovers)
    .innerJoin(playbookStepRuns, eq(playbookStepRuns.id, playbookGateApprovers.stepRunId))
    .innerJoin(playbookRuns, eq(playbookRuns.id, playbookStepRuns.runId))
    .where(predicate);
  return {
    rows: rows.filter((row): row is typeof row & { deadline: string } => Boolean(row.deadline)),
    total: totals?.value ?? 0,
  };
}

/** Fails production gates whose suspend-time pool no longer has any current project member. */
export async function failGatesWithEmptyCurrentPools(): Promise<number> {
  const gates = await db.select({
    stepRunId: playbookStepRuns.id,
    runId: playbookRuns.id,
    project: playbookRuns.project,
    pool: playbookStepRuns.gatePoolKey,
  }).from(playbookStepRuns)
    .innerJoin(playbookRuns, eq(playbookRuns.id, playbookStepRuns.runId))
    .where(and(
      eq(playbookStepRuns.status, 'suspended'),
      inArray(playbookRuns.status, ['running', 'suspended']),
    ));

  let failed = 0;
  for (const gate of gates) {
    if (!gate.pool) continue;
    const current = await currentPoolUserIds(gate.project, gate.pool);
    if (current.size > 0) continue;
    const reason = new PlaybookGateEmptyPoolError(gate.pool).message;
    const moved = await db.update(playbookStepRuns).set({
      status: 'failed',
      outputInline: { error: reason },
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(playbookStepRuns.id, gate.stepRunId),
      eq(playbookStepRuns.status, 'suspended'),
    )).returning({ id: playbookStepRuns.id });
    if (moved.length === 0) continue;
    await db.update(playbookRuns).set({
      status: 'failed',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(playbookRuns.id, gate.runId),
      inArray(playbookRuns.status, ['running', 'suspended']),
    ));
    failed += 1;
  }
  return failed;
}
