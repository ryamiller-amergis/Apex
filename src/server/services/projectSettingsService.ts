import { db } from '../db/drizzle';
import { projectSkillSettings, projectApprovers, projectApproverGroups, appGroupMembers, appGroups, appUsers } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import * as groupService from './groupService';
import type { ProjectSkillConfig, ProjectApprover, QuickSkillPill, QuickMcpPill, ApproverPoolResponse } from '../../shared/types/projectSettings';
import type { GroupWithMembers } from '../../shared/types/groups';
import type { ApprovalMode } from '../../shared/types/approvals';

function toSkillConfig(row: Record<string, unknown>): ProjectSkillConfig {
  return { ...row, approvalMode: row.approvalMode as ApprovalMode | undefined } as ProjectSkillConfig;
}

export async function getSkillConfig(project: string): Promise<ProjectSkillConfig | null> {
  const rows = await db
    .select()
    .from(projectSkillSettings)
    .where(eq(projectSkillSettings.project, project))
    .limit(1);
  return rows[0] ? toSkillConfig(rows[0]) : null;
}

export async function listSkillConfigs(): Promise<ProjectSkillConfig[]> {
  const rows = await db.select().from(projectSkillSettings).orderBy(projectSkillSettings.project);
  return rows.map(toSkillConfig);
}

export async function upsertSkillConfig(
  project: string,
  skillRepo: string,
  skillBranch: string,
  updatedBy?: string,
  interviewSkillPath?: string | null,
  prdSkillPath?: string | null,
  designDocSkillPath?: string | null,
  interviewModel?: string | null,
  prdModel?: string | null,
  designDocModel?: string | null,
  designDocQaSkillPath?: string | null,
  designDocQaModel?: string | null,
  designDocAssistantSkillPath?: string | null,
  designDocAssistantModel?: string | null,
  designPrototypeSkillPath?: string | null,
  designPrototypeModel?: string | null,
  designDocValidationSkillPath?: string | null,
  designDocValidationModel?: string | null,
  quickSkillPills?: QuickSkillPill[] | null | undefined,
  defaultModel?: string | null,
  approvalMode?: ApprovalMode,
  quickMcpPills?: QuickMcpPill[] | null | undefined,
  prdAssistantSkillPath?: string | null,
  prdAssistantModel?: string | null,
  prdReviewBedrockModelId?: string | null,
  prdReviewBedrockMaxTokens?: number | null,
  designPrototypeBedrockModelId?: string | null,
  designPrototypeBedrockMaxTokens?: number | null,
  designPrototypeBedrockTimeoutMs?: number | null,
  designPrototypeRegenBedrockModelId?: string | null,
  designPrototypeRegenBedrockMaxTokens?: number | null,
  testCaseSkillPath?: string | null,
  testCaseModel?: string | null,
  prdValidationSkillPath?: string | null,
  prdValidationModel?: string | null,
  designPlanBedrockModelId?: string | null,
  designPlanBedrockMaxTokens?: number | null,
  prdValidationScoreThreshold?: number | null,
): Promise<ProjectSkillConfig> {
  const now = new Date().toISOString();
  const approvalModeValue = approvalMode ?? 'any_one';
  const rows = await db
    .insert(projectSkillSettings)
    .values({
      project,
      skillRepo,
      skillBranch,
      updatedBy,
      interviewSkillPath: interviewSkillPath ?? null,
      prdSkillPath: prdSkillPath ?? null,
      designDocSkillPath: designDocSkillPath ?? null,
      designDocQaSkillPath: designDocQaSkillPath ?? null,
      designDocAssistantSkillPath: designDocAssistantSkillPath ?? null,
      designPrototypeSkillPath: designPrototypeSkillPath ?? null,
      testCaseSkillPath: testCaseSkillPath ?? null,
      designDocValidationSkillPath: designDocValidationSkillPath ?? null,
      prdAssistantSkillPath: prdAssistantSkillPath ?? null,
      interviewModel: interviewModel ?? null,
      prdModel: prdModel ?? null,
      designDocModel: designDocModel ?? null,
      designDocQaModel: designDocQaModel ?? null,
      designDocAssistantModel: designDocAssistantModel ?? null,
      designPrototypeModel: designPrototypeModel ?? null,
      testCaseModel: testCaseModel ?? null,
      designDocValidationModel: designDocValidationModel ?? null,
      prdAssistantModel: prdAssistantModel ?? null,
      prdValidationSkillPath: prdValidationSkillPath ?? null,
      prdValidationModel: prdValidationModel ?? null,
      prdReviewBedrockModelId: prdReviewBedrockModelId ?? null,
      prdReviewBedrockMaxTokens: prdReviewBedrockMaxTokens ?? null,
      designPrototypeBedrockModelId: designPrototypeBedrockModelId ?? null,
      designPrototypeBedrockMaxTokens: designPrototypeBedrockMaxTokens ?? null,
      designPrototypeBedrockTimeoutMs: designPrototypeBedrockTimeoutMs ?? null,
      designPrototypeRegenBedrockModelId: designPrototypeRegenBedrockModelId ?? null,
      designPrototypeRegenBedrockMaxTokens: designPrototypeRegenBedrockMaxTokens ?? null,
      designPlanBedrockModelId: designPlanBedrockModelId ?? null,
      designPlanBedrockMaxTokens: designPlanBedrockMaxTokens ?? null,
      prdValidationScoreThreshold: prdValidationScoreThreshold ?? null,
      quickSkillPills: quickSkillPills ?? null,
      quickMcpPills: quickMcpPills ?? null,
      defaultModel: defaultModel ?? null,
      approvalMode: approvalModeValue,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: projectSkillSettings.project,
      set: {
        skillRepo,
        skillBranch,
        updatedBy,
        interviewSkillPath: interviewSkillPath ?? null,
        prdSkillPath: prdSkillPath ?? null,
        designDocSkillPath: designDocSkillPath ?? null,
        designDocQaSkillPath: designDocQaSkillPath ?? null,
        designDocAssistantSkillPath: designDocAssistantSkillPath ?? null,
        designPrototypeSkillPath: designPrototypeSkillPath ?? null,
        testCaseSkillPath: testCaseSkillPath ?? null,
        designDocValidationSkillPath: designDocValidationSkillPath ?? null,
        prdAssistantSkillPath: prdAssistantSkillPath ?? null,
        interviewModel: interviewModel ?? null,
        prdModel: prdModel ?? null,
        designDocModel: designDocModel ?? null,
        designDocQaModel: designDocQaModel ?? null,
        designDocAssistantModel: designDocAssistantModel ?? null,
        designPrototypeModel: designPrototypeModel ?? null,
        testCaseModel: testCaseModel ?? null,
        designDocValidationModel: designDocValidationModel ?? null,
        prdAssistantModel: prdAssistantModel ?? null,
        prdValidationSkillPath: prdValidationSkillPath ?? null,
        prdValidationModel: prdValidationModel ?? null,
        prdReviewBedrockModelId: prdReviewBedrockModelId ?? null,
        prdReviewBedrockMaxTokens: prdReviewBedrockMaxTokens ?? null,
        designPrototypeBedrockModelId: designPrototypeBedrockModelId ?? null,
        designPrototypeBedrockMaxTokens: designPrototypeBedrockMaxTokens ?? null,
        designPrototypeBedrockTimeoutMs: designPrototypeBedrockTimeoutMs ?? null,
        designPrototypeRegenBedrockModelId: designPrototypeRegenBedrockModelId ?? null,
        designPrototypeRegenBedrockMaxTokens: designPrototypeRegenBedrockMaxTokens ?? null,
        designPlanBedrockModelId: designPlanBedrockModelId ?? null,
        designPlanBedrockMaxTokens: designPlanBedrockMaxTokens ?? null,
        prdValidationScoreThreshold: prdValidationScoreThreshold ?? null,
        quickSkillPills: quickSkillPills ?? null,
        quickMcpPills: quickMcpPills ?? null,
        defaultModel: defaultModel ?? null,
        approvalMode: approvalModeValue,
        updatedAt: now,
      },
    })
    .returning();
  await groupService.seedDefaultGroupsForProject(project, updatedBy);
  return toSkillConfig(rows[0]);
}

export async function deleteSkillConfig(project: string): Promise<void> {
  await db.delete(projectSkillSettings).where(eq(projectSkillSettings.project, project));
}

// ── Approver Management ──────────────────────────────────────────────────────

export async function listApprovers(project: string): Promise<ProjectApprover[]> {
  const rows = await db
    .select({
      id: projectApprovers.id,
      project: projectApprovers.project,
      userId: projectApprovers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
      documentType: projectApprovers.documentType,
      assignedBy: projectApprovers.assignedBy,
      assignedAt: projectApprovers.assignedAt,
    })
    .from(projectApprovers)
    .innerJoin(appUsers, eq(projectApprovers.userId, appUsers.oid))
    .where(eq(projectApprovers.project, project));

  return rows.map((r) => ({
    ...r,
    documentType: r.documentType as 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
  }));
}

export async function listApproversForAllProjects(): Promise<Record<string, ProjectApprover[]>> {
  const rows = await db
    .select({
      id: projectApprovers.id,
      project: projectApprovers.project,
      userId: projectApprovers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
      documentType: projectApprovers.documentType,
      assignedBy: projectApprovers.assignedBy,
      assignedAt: projectApprovers.assignedAt,
    })
    .from(projectApprovers)
    .innerJoin(appUsers, eq(projectApprovers.userId, appUsers.oid));

  const grouped: Record<string, ProjectApprover[]> = {};
  for (const r of rows) {
    const approver: ProjectApprover = {
      ...r,
      documentType: r.documentType as 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
    };
    if (!grouped[r.project]) grouped[r.project] = [];
    grouped[r.project].push(approver);
  }
  return grouped;
}

export async function setApprovers(
  project: string,
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
  userIds: string[],
  assignedBy?: string,
): Promise<ProjectApprover[]> {
  await db.transaction(async (tx) => {
    await tx
      .delete(projectApprovers)
      .where(and(eq(projectApprovers.project, project), eq(projectApprovers.documentType, documentType)));

    if (userIds.length > 0) {
      await tx.insert(projectApprovers).values(
        userIds.map((userId) => ({
          project,
          userId,
          documentType,
          assignedBy: assignedBy ?? null,
        })),
      );
    }
  });

  return getApproversForDocument(project, documentType);
}

export async function getApproversForDocument(
  project: string,
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
): Promise<ProjectApprover[]> {
  const rows = await db
    .select({
      id: projectApprovers.id,
      project: projectApprovers.project,
      userId: projectApprovers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
      documentType: projectApprovers.documentType,
      assignedBy: projectApprovers.assignedBy,
      assignedAt: projectApprovers.assignedAt,
    })
    .from(projectApprovers)
    .innerJoin(appUsers, eq(projectApprovers.userId, appUsers.oid))
    .where(and(eq(projectApprovers.project, project), eq(projectApprovers.documentType, documentType)));

  return rows.map((r) => ({
    ...r,
    documentType: r.documentType as 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
  }));
}

export async function setApproverGroups(
  project: string,
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
  groupIds: string[],
  assignedBy?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(projectApproverGroups)
      .where(and(eq(projectApproverGroups.project, project), eq(projectApproverGroups.documentType, documentType)));

    if (groupIds.length > 0) {
      await tx.insert(projectApproverGroups).values(
        groupIds.map((groupId) => ({
          project,
          groupId,
          documentType,
          assignedBy: assignedBy ?? null,
        })),
      );
    }
  });
}

export async function getApproverPool(
  project: string,
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
): Promise<ApproverPoolResponse> {
  const individuals = await getApproversForDocument(project, documentType);

  const groupRefs = await db
    .select({
      id: projectApproverGroups.id,
      project: projectApproverGroups.project,
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
    .where(and(eq(projectApproverGroups.project, project), eq(projectApproverGroups.documentType, documentType)));

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
  project: string,
  documentType: 'design_doc' | 'prd' | 'design_prototype' | 'test_case',
): Promise<string[]> {
  const pool = await getApproverPool(project, documentType);
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

export async function listApproverGroupsForProject(
  project: string,
): Promise<Array<{ groupId: string; groupName: string; documentType: string }>> {
  const rows = await db
    .select({
      groupId: projectApproverGroups.groupId,
      groupName: appGroups.name,
      documentType: projectApproverGroups.documentType,
    })
    .from(projectApproverGroups)
    .innerJoin(appGroups, eq(projectApproverGroups.groupId, appGroups.id))
    .where(eq(projectApproverGroups.project, project));
  return rows;
}

export async function listApproverGroupsForAllProjects(): Promise<
  Record<string, Array<{ groupId: string; groupName: string; documentType: string }>>
> {
  const rows = await db
    .select({
      project: projectApproverGroups.project,
      groupId: projectApproverGroups.groupId,
      groupName: appGroups.name,
      documentType: projectApproverGroups.documentType,
    })
    .from(projectApproverGroups)
    .innerJoin(appGroups, eq(projectApproverGroups.groupId, appGroups.id));

  const grouped: Record<string, Array<{ groupId: string; groupName: string; documentType: string }>> = {};
  for (const r of rows) {
    if (!grouped[r.project]) grouped[r.project] = [];
    grouped[r.project].push({
      groupId: r.groupId,
      groupName: r.groupName,
      documentType: r.documentType,
    });
  }
  return grouped;
}
