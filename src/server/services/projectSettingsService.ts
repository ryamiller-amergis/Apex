import { db } from '../db/drizzle';
import { projectSkillSettings, projectApprovers, projectApproverGroups, appGroupMembers, appGroups, appUsers } from '../db/schema';
import { eq, and, asc, desc } from 'drizzle-orm';
import * as groupService from './groupService';
import type { ProjectSkillConfig, ProjectApprover, QuickSkillPill, QuickMcpPill, InterviewSkillOption, ApproverPoolResponse, SkillProvider } from '../../shared/types/projectSettings';
import type { GroupWithMembers } from '../../shared/types/groups';
import type { ApprovalMode } from '../../shared/types/approvals';

function toSkillConfig(row: Record<string, unknown>): ProjectSkillConfig {
  return { ...row, approvalMode: row.approvalMode as ApprovalMode | undefined } as ProjectSkillConfig;
}

/** Returns the **default** config for a project (back-compat for existing callers). */
export async function getSkillConfig(project: string): Promise<ProjectSkillConfig | null> {
  const rows = await db
    .select()
    .from(projectSkillSettings)
    .where(and(eq(projectSkillSettings.project, project), eq(projectSkillSettings.isDefault, true)))
    .limit(1);
  return rows[0] ? toSkillConfig(rows[0]) : null;
}

export async function getSkillConfigById(id: string): Promise<ProjectSkillConfig | null> {
  const rows = await db
    .select()
    .from(projectSkillSettings)
    .where(eq(projectSkillSettings.id, id))
    .limit(1);
  return rows[0] ? toSkillConfig(rows[0]) : null;
}

export async function listSkillConfigsForProject(project: string): Promise<ProjectSkillConfig[]> {
  const rows = await db
    .select()
    .from(projectSkillSettings)
    .where(eq(projectSkillSettings.project, project))
    .orderBy(desc(projectSkillSettings.isDefault), asc(projectSkillSettings.friendlyName));
  return rows.map(toSkillConfig);
}

export async function resolveSkillConfig(opts: { project: string; settingsId?: string }): Promise<ProjectSkillConfig | null> {
  if (opts.settingsId) return getSkillConfigById(opts.settingsId);
  return getSkillConfig(opts.project);
}

export async function listSkillConfigs(): Promise<ProjectSkillConfig[]> {
  const rows = await db.select().from(projectSkillSettings).orderBy(projectSkillSettings.project);
  return rows.map(toSkillConfig);
}

export async function getSkillSettingsName(settingsId: string | null | undefined): Promise<string | null> {
  if (!settingsId) return null;
  const row = await db.query.projectSkillSettings.findFirst({
    where: eq(projectSkillSettings.id, settingsId),
    columns: { friendlyName: true },
  });
  return row?.friendlyName ?? null;
}

// ── Upsert / Delete ──────────────────────────────────────────────────────────

export interface UpsertSkillConfigOptions {
  id?: string;
  project: string;
  friendlyName: string;
  skillProvider?: SkillProvider;
  skillRepo: string;
  skillBranch: string;
  isDefault?: boolean;
  updatedBy?: string;
  interviewSkillPath?: string | null;
  prdSkillPath?: string | null;
  designDocSkillPath?: string | null;
  designDocAssistantSkillPath?: string | null;
  designPrototypeSkillPath?: string | null;
  testCaseSkillPath?: string | null;
  designDocValidationSkillPath?: string | null;
  prdValidationSkillPath?: string | null;
  interviewModel?: string | null;
  prdModel?: string | null;
  designDocModel?: string | null;
  designDocAssistantModel?: string | null;
  designPrototypeModel?: string | null;
  testCaseModel?: string | null;
  designDocValidationModel?: string | null;
  prdAssistantSkillPath?: string | null;
  prdAssistantModel?: string | null;
  prdValidationModel?: string | null;
  defaultModel?: string | null;
  prdReviewBedrockModelId?: string | null;
  prdReviewBedrockMaxTokens?: number | null;
  designPrototypeBedrockModelId?: string | null;
  designPrototypeBedrockMaxTokens?: number | null;
  designPrototypeBedrockTimeoutMs?: number | null;
  designPrototypeRegenBedrockModelId?: string | null;
  designPrototypeRegenBedrockMaxTokens?: number | null;
  designPlanBedrockModelId?: string | null;
  designPlanBedrockMaxTokens?: number | null;
  developmentSkillPath?: string | null;
  developmentModel?: string | null;
  featureRequestSkillPath?: string | null;
  featureRequestModel?: string | null;
  technicalSkillPath?: string | null;
  technicalModel?: string | null;
  issueSkillPath?: string | null;
  issueModel?: string | null;
  prdValidationScoreThreshold?: number | null;
  uiLabBedrockModelId?: string | null;
  uiLabBedrockMaxTokens?: number | null;
  uiLabBedrockTimeoutMs?: number | null;
  uiLabRegenBedrockModelId?: string | null;
  uiLabRegenBedrockMaxTokens?: number | null;
  uiLabBedrockTemperature?: number | null;
  uiLabSkillPath?: string | null;
  calendarAssistantSkillPath?: string | null;
  calendarAssistantModel?: string | null;
  quickSkillPills?: QuickSkillPill[] | null;
  quickMcpPills?: QuickMcpPill[] | null;
  interviewSkillOptions?: InterviewSkillOption[] | null;
  prototypeStageEnabled?: boolean;
  approvalMode?: ApprovalMode;
}

export async function upsertSkillConfig(opts: UpsertSkillConfigOptions): Promise<ProjectSkillConfig> {
  const now = new Date().toISOString();
  const approvalModeValue = opts.approvalMode ?? 'any_one';

  const values = {
    project: opts.project,
    friendlyName: opts.friendlyName,
    skillProvider: opts.skillProvider ?? 'ado',
    skillRepo: opts.skillRepo,
    skillBranch: opts.skillBranch,
    isDefault: opts.isDefault ?? false,
    updatedBy: opts.updatedBy,
    interviewSkillPath: opts.interviewSkillPath ?? null,
    prdSkillPath: opts.prdSkillPath ?? null,
    designDocSkillPath: opts.designDocSkillPath ?? null,
    designDocAssistantSkillPath: opts.designDocAssistantSkillPath ?? null,
    designPrototypeSkillPath: opts.designPrototypeSkillPath ?? null,
    testCaseSkillPath: opts.testCaseSkillPath ?? null,
    designDocValidationSkillPath: opts.designDocValidationSkillPath ?? null,
    prdAssistantSkillPath: opts.prdAssistantSkillPath ?? null,
    interviewModel: opts.interviewModel ?? null,
    prdModel: opts.prdModel ?? null,
    designDocModel: opts.designDocModel ?? null,
    designDocAssistantModel: opts.designDocAssistantModel ?? null,
    designPrototypeModel: opts.designPrototypeModel ?? null,
    testCaseModel: opts.testCaseModel ?? null,
    designDocValidationModel: opts.designDocValidationModel ?? null,
    prdAssistantModel: opts.prdAssistantModel ?? null,
    prdValidationSkillPath: opts.prdValidationSkillPath ?? null,
    prdValidationModel: opts.prdValidationModel ?? null,
    prdReviewBedrockModelId: opts.prdReviewBedrockModelId ?? null,
    prdReviewBedrockMaxTokens: opts.prdReviewBedrockMaxTokens ?? null,
    designPrototypeBedrockModelId: opts.designPrototypeBedrockModelId ?? null,
    designPrototypeBedrockMaxTokens: opts.designPrototypeBedrockMaxTokens ?? null,
    designPrototypeBedrockTimeoutMs: opts.designPrototypeBedrockTimeoutMs ?? null,
    designPrototypeRegenBedrockModelId: opts.designPrototypeRegenBedrockModelId ?? null,
    designPrototypeRegenBedrockMaxTokens: opts.designPrototypeRegenBedrockMaxTokens ?? null,
    designPlanBedrockModelId: opts.designPlanBedrockModelId ?? null,
    designPlanBedrockMaxTokens: opts.designPlanBedrockMaxTokens ?? null,
    developmentSkillPath: opts.developmentSkillPath ?? null,
    developmentModel: opts.developmentModel ?? null,
    featureRequestSkillPath: opts.featureRequestSkillPath ?? null,
    featureRequestModel: opts.featureRequestModel ?? null,
    technicalSkillPath: opts.technicalSkillPath ?? null,
    technicalModel: opts.technicalModel ?? null,
    issueSkillPath: opts.issueSkillPath ?? null,
    issueModel: opts.issueModel ?? null,
    prdValidationScoreThreshold: opts.prdValidationScoreThreshold ?? null,
    uiLabBedrockModelId: opts.uiLabBedrockModelId ?? null,
    uiLabBedrockMaxTokens: opts.uiLabBedrockMaxTokens ?? null,
    uiLabBedrockTimeoutMs: opts.uiLabBedrockTimeoutMs ?? null,
    uiLabRegenBedrockModelId: opts.uiLabRegenBedrockModelId ?? null,
    uiLabRegenBedrockMaxTokens: opts.uiLabRegenBedrockMaxTokens ?? null,
    uiLabBedrockTemperature: opts.uiLabBedrockTemperature ?? null,
    uiLabSkillPath: opts.uiLabSkillPath ?? null,
    calendarAssistantSkillPath: opts.calendarAssistantSkillPath ?? null,
    calendarAssistantModel: opts.calendarAssistantModel ?? null,
    quickSkillPills: opts.quickSkillPills ?? null,
    quickMcpPills: opts.quickMcpPills ?? null,
    interviewSkillOptions: opts.interviewSkillOptions ?? null,
    prototypeStageEnabled: opts.prototypeStageEnabled ?? true,
    defaultModel: opts.defaultModel ?? null,
    approvalMode: approvalModeValue,
    updatedAt: now,
  };

  const result = await db.transaction(async (tx) => {
    if (values.isDefault) {
      await tx
        .update(projectSkillSettings)
        .set({ isDefault: false })
        .where(and(eq(projectSkillSettings.project, opts.project), eq(projectSkillSettings.isDefault, true)));
    }

    if (opts.id) {
      const rows = await tx
        .update(projectSkillSettings)
        .set(values)
        .where(eq(projectSkillSettings.id, opts.id))
        .returning();
      return rows[0];
    }

    // INSERT — if it's the first config for the project, force isDefault = true
    const existing = await tx
      .select({ id: projectSkillSettings.id })
      .from(projectSkillSettings)
      .where(eq(projectSkillSettings.project, opts.project))
      .limit(1);
    if (existing.length === 0) {
      values.isDefault = true;
    }

    const rows = await tx
      .insert(projectSkillSettings)
      .values(values)
      .returning();
    return rows[0];
  });

  await groupService.seedDefaultGroupsForProject(opts.project, opts.updatedBy);
  return toSkillConfig(result);
}

export async function deleteSkillConfig(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(projectSkillSettings)
      .where(eq(projectSkillSettings.id, id))
      .limit(1);

    if (rows.length === 0) return;
    const row = rows[0];

    const siblings = await tx
      .select({ id: projectSkillSettings.id })
      .from(projectSkillSettings)
      .where(eq(projectSkillSettings.project, row.project));

    if (siblings.length <= 1) {
      throw new Error('Cannot delete the only repo config for a project');
    }

    await tx.delete(projectSkillSettings).where(eq(projectSkillSettings.id, id));

    if (row.isDefault) {
      const oldest = await tx
        .select({ id: projectSkillSettings.id })
        .from(projectSkillSettings)
        .where(eq(projectSkillSettings.project, row.project))
        .orderBy(asc(projectSkillSettings.createdAt))
        .limit(1);

      if (oldest.length > 0) {
        await tx
          .update(projectSkillSettings)
          .set({ isDefault: true })
          .where(eq(projectSkillSettings.id, oldest[0].id));
      }
    }
  });
}

// ── Approver Management ──────────────────────────────────────────────────────

export async function listApprovers(settingsId: string): Promise<ProjectApprover[]> {
  const rows = await db
    .select({
      id: projectApprovers.id,
      settingsId: projectApprovers.settingsId,
      userId: projectApprovers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
      documentType: projectApprovers.documentType,
      assignedBy: projectApprovers.assignedBy,
      assignedAt: projectApprovers.assignedAt,
    })
    .from(projectApprovers)
    .innerJoin(appUsers, eq(projectApprovers.userId, appUsers.oid))
    .where(eq(projectApprovers.settingsId, settingsId));

  return rows.map((r) => ({
    ...r,
    documentType: r.documentType as 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
  }));
}

export async function listApproversForAllProjects(): Promise<Record<string, ProjectApprover[]>> {
  let rows: Array<{
    id: string; settingsId: string; userId: string; displayName: string | null;
    email: string | null; documentType: string; assignedBy: string | null; assignedAt: string;
  }>;
  try {
    rows = await db
      .select({
        id: projectApprovers.id,
        settingsId: projectApprovers.settingsId,
        userId: projectApprovers.userId,
        displayName: appUsers.displayName,
        email: appUsers.email,
        documentType: projectApprovers.documentType,
        assignedBy: projectApprovers.assignedBy,
        assignedAt: projectApprovers.assignedAt,
      })
      .from(projectApprovers)
      .innerJoin(appUsers, eq(projectApprovers.userId, appUsers.oid));
  } catch {
    // Table may not exist on fresh local environments; return empty gracefully.
    return {};
  }

  const grouped: Record<string, ProjectApprover[]> = {};
  for (const r of rows) {
    const approver: ProjectApprover = {
      ...r,
      documentType: r.documentType as 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
    };
    if (!grouped[r.settingsId]) grouped[r.settingsId] = [];
    grouped[r.settingsId].push(approver);
  }
  return grouped;
}

export async function setApprovers(
  settingsId: string,
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
  userIds: string[],
  assignedBy?: string,
): Promise<ProjectApprover[]> {
  await db.transaction(async (tx) => {
    await tx
      .delete(projectApprovers)
      .where(and(eq(projectApprovers.settingsId, settingsId), eq(projectApprovers.documentType, documentType)));

    if (userIds.length > 0) {
      await tx.insert(projectApprovers).values(
        userIds.map((userId) => ({
          settingsId,
          userId,
          documentType,
          assignedBy: assignedBy ?? null,
        })),
      );
    }
  });

  return getApproversForDocument(settingsId, documentType);
}

export async function getApproversForDocument(
  settingsId: string,
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
): Promise<ProjectApprover[]> {
  const rows = await db
    .select({
      id: projectApprovers.id,
      settingsId: projectApprovers.settingsId,
      userId: projectApprovers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
      documentType: projectApprovers.documentType,
      assignedBy: projectApprovers.assignedBy,
      assignedAt: projectApprovers.assignedAt,
    })
    .from(projectApprovers)
    .innerJoin(appUsers, eq(projectApprovers.userId, appUsers.oid))
    .where(and(eq(projectApprovers.settingsId, settingsId), eq(projectApprovers.documentType, documentType)));

  return rows.map((r) => ({
    ...r,
    documentType: r.documentType as 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
  }));
}

export async function setApproverGroups(
  settingsId: string,
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
  groupIds: string[],
  assignedBy?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(projectApproverGroups)
      .where(and(eq(projectApproverGroups.settingsId, settingsId), eq(projectApproverGroups.documentType, documentType)));

    if (groupIds.length > 0) {
      await tx.insert(projectApproverGroups).values(
        groupIds.map((groupId) => ({
          settingsId,
          groupId,
          documentType,
          assignedBy: assignedBy ?? null,
        })),
      );
    }
  });
}

export async function getApproverPool(
  settingsId: string,
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
): Promise<ApproverPoolResponse> {
  const individuals = await getApproversForDocument(settingsId, documentType);

  const groupRefs = await db
    .select({
      id: projectApproverGroups.id,
      settingsId: projectApproverGroups.settingsId,
      groupId: projectApproverGroups.groupId,
      documentType: projectApproverGroups.documentType,
      assignedBy: projectApproverGroups.assignedBy,
      assignedAt: projectApproverGroups.assignedAt,
      groupName: appGroups.name,
      groupDescription: appGroups.description,
      groupProject: appGroups.project,
      groupIsDefault: appGroups.isDefault,
      groupCreatedBy: appGroups.createdBy,
      groupCreatedAt: appGroups.createdAt,
    })
    .from(projectApproverGroups)
    .innerJoin(appGroups, eq(projectApproverGroups.groupId, appGroups.id))
    .where(and(eq(projectApproverGroups.settingsId, settingsId), eq(projectApproverGroups.documentType, documentType)));

  const groups: Array<GroupWithMembers & { documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case' }> = [];
  for (const ref of groupRefs) {
    const memberRows = await db
      .select({
        groupId: appGroupMembers.groupId,
        userId: appGroupMembers.userId,
        displayName: appUsers.displayName,
        email: appUsers.email,
        addedBy: appGroupMembers.addedBy,
        addedAt: appGroupMembers.addedAt,
      })
      .from(appGroupMembers)
      .innerJoin(appUsers, eq(appGroupMembers.userId, appUsers.oid))
      .where(eq(appGroupMembers.groupId, ref.groupId));

    groups.push({
      id: ref.groupId,
      name: ref.groupName,
      description: ref.groupDescription,
      project: ref.groupProject,
      isDefault: ref.groupIsDefault,
      createdBy: ref.groupCreatedBy,
      createdAt: ref.groupCreatedAt,
      documentType: ref.documentType as 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
      members: memberRows,
    });
  }

  return { individuals, groups };
}

export async function getApproverUserIds(
  settingsId: string,
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
): Promise<string[]> {
  const pool = await getApproverPool(settingsId, documentType);
  const userIds = new Set<string>();
  for (const ind of pool.individuals) {
    userIds.add(ind.userId);
  }
  for (const group of pool.groups) {
    for (const member of group.members) {
      userIds.add(member.userId);
    }
  }
  return [...userIds];
}

/** Back-compat wrapper: resolves the default config for a project, then fetches approver user IDs. */
export async function getApproverUserIdsForProject(
  project: string,
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
): Promise<string[]> {
  const config = await getSkillConfig(project);
  if (!config?.id) return [];
  return getApproverUserIds(config.id, documentType);
}

/** Back-compat wrapper: resolves the default config for a project, then fetches the approver pool. */
export async function getApproverPoolForProject(
  project: string,
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
): Promise<ApproverPoolResponse> {
  const config = await getSkillConfig(project);
  if (!config?.id) return { individuals: [], groups: [] };
  return getApproverPool(config.id, documentType);
}

/** Back-compat wrapper: resolves the default config for a project, then fetches approvers for a document type. */
export async function getApproversForDocumentByProject(
  project: string,
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
): Promise<ProjectApprover[]> {
  const config = await getSkillConfig(project);
  if (!config?.id) return [];
  return getApproversForDocument(config.id, documentType);
}

export async function listApproverGroupsForProject(
  settingsId: string,
): Promise<Array<{ groupId: string; groupName: string; documentType: string }>> {
  const rows = await db
    .select({
      groupId: projectApproverGroups.groupId,
      groupName: appGroups.name,
      documentType: projectApproverGroups.documentType,
    })
    .from(projectApproverGroups)
    .innerJoin(appGroups, eq(projectApproverGroups.groupId, appGroups.id))
    .where(eq(projectApproverGroups.settingsId, settingsId));
  return rows;
}

export async function listApproverGroupsForAllProjects(): Promise<
  Record<string, Array<{ groupId: string; groupName: string; documentType: string }>>
> {
  let rows: Array<{ settingsId: string; groupId: string; groupName: string; documentType: string }>;
  try {
    rows = await db
      .select({
        settingsId: projectApproverGroups.settingsId,
        groupId: projectApproverGroups.groupId,
        groupName: appGroups.name,
        documentType: projectApproverGroups.documentType,
      })
      .from(projectApproverGroups)
      .innerJoin(appGroups, eq(projectApproverGroups.groupId, appGroups.id));
  } catch {
    // Table may not exist on fresh local environments; return empty gracefully.
    return {};
  }

  const grouped: Record<string, Array<{ groupId: string; groupName: string; documentType: string }>> = {};
  for (const r of rows) {
    if (!grouped[r.settingsId]) grouped[r.settingsId] = [];
    grouped[r.settingsId].push({
      groupId: r.groupId,
      groupName: r.groupName,
      documentType: r.documentType,
    });
  }
  return grouped;
}
